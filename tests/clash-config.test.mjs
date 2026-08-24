import assert from "node:assert/strict";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import {
  buildClashConfig,
  buildShadowrocketRuleConfigFromClash,
  buildShadowrocketConfig,
  buildShadowrocketRulesConfig,
  filterHiddenGroups,
  resolveAirportProxyHosts,
} from "../app/lib/clash-config.ts";
import { composeBoundRuleSets } from "../app/lib/rule-set-core.ts";

const flowerRules = `
proxy-groups:
  - name: PROXY
    type: select
    proxies: [DIRECT]
  - name: 韩国
    type: select
    proxies: [PROXY]
    filter: "韩国|Korea"
rule-providers:
  social:
    type: http
    behavior: domain
    url: https://rules.example/social.yaml
rules:
  - RULE-SET,social,PROXY
  - DOMAIN-SUFFIX,kr.example,韩国
  - MATCH,PROXY
`;

const rules = `
[Proxy Group]
Proxies = select,US,KR
Final = select,include-all-proxies=true,Proxies,DIRECT
US = select,policy-regex-filter=美国|US
KR = select,policy-regex-filter=韩国|KR

[Rule]
DOMAIN-SUFFIX,bybdc6.com,KR
FINAL,Final
`;

const strategyRules = `
[Proxy Group]
Auto = url-test,include-all-proxies=true,DIRECT,url=https://www.gstatic.com/generate_204,interval=300,tolerance=50
Failover = fallback,include-all-proxies=true,DIRECT,url=https://www.gstatic.com/generate_204,interval=300
Balance = load-balance,include-all-proxies=true,DIRECT,strategy=consistent-hashing,url=https://www.gstatic.com/generate_204,interval=300

[Rule]
FINAL,Auto
`;

const airport = `
proxies:
  - name: 美国节点 1
    type: ss
    server: us.example.com
    port: 443
    cipher: aes-128-gcm
    password: test-us
  - name: 韩国节点 1
    type: ss
    server: kr.example.com
    port: 443
    cipher: aes-128-gcm
    password: test-kr
`;

const kqsAirport = `
dns:
  default-nameserver:
    - 223.5.5.5
  proxy-server-nameserver:
    - https://kqs-resolver.example/dns-query
  nameserver:
    - https://doh.example/dns-query
  fallback:
    - https://fallback.example/dns-query
  fake-ip-filter:
    - "*"
    - "+.lan"
    - "+.local"
proxies:
  - name: VIP 香港 01
    type: ss
    server: kqs-hk.kunlun03dns.com
    port: 25101
    cipher: aes-128-gcm
    password: test-kqs
  - name: 花云香港 IEPL 1
    type: ss
    server: flower.example.com
    port: 443
    cipher: aes-128-gcm
    password: test-flower
`;

test("one group can merge multiple rule sets and dedupe generated rules", () => {
  const source = "[Rule]\nDOMAIN-SUFFIX,old.example,Google\nFINAL,DIRECT\n";
  const ruleSets = [
    { id: "one", name: "Google", entries: [{ type: "DOMAIN-SUFFIX", value: "dup.example" }] },
    { id: "two", name: "Google Extra", entries: [
      { type: "DOMAIN-SUFFIX", value: "dup.example" },
      { type: "DOMAIN-SUFFIX", value: "second.example" },
    ] },
  ];
  const bindings = [
    { groupName: "Google", ruleSetId: "one" },
    { groupName: "Google", ruleSetId: "two" },
  ];
  const shadowrocket = composeBoundRuleSets(source, ruleSets, bindings, "shadowrocket");
  assert.equal((shadowrocket.match(/DOMAIN-SUFFIX,dup\.example,Google/g) || []).length, 1);
  assert.match(shadowrocket, /DOMAIN-SUFFIX,second\.example,Google/);

  const clash = composeBoundRuleSets(source, ruleSets, { Google: ["one", "two"] }, "clash");
  assert.equal((clash.match(/DOMAIN-SUFFIX,dup\.example,Google/g) || []).length, 1);
  assert.match(clash, /DOMAIN-SUFFIX,second\.example,Google/);
});

test("Clash FINAL uses a dedicated fallback group with Proxies as default", () => {
  const config = parseYaml(buildClashConfig(rules, airport));
  const finalGroups = config["proxy-groups"].filter((group) => group.name === "MW-FINAL");
  assert.equal(finalGroups.length, 1);
  assert.deepEqual(finalGroups[0].proxies, ["Proxies", "DIRECT"]);
  assert.ok(config.rules.includes("MATCH,MW-FINAL"));
  assert.ok(config.rules.includes("DOMAIN-SUFFIX,bybdc6.com,KR"));
  assert.ok(!config.rules.some((rule) => /^MATCH,Final$/i.test(rule)));
});

test("Clash keeps Proxies child strategy groups selected in the rule scheme", () => {
  const scheme = `
[Proxy Group]
Proxies = select,include-all-proxies=true,DIRECT,自动选择,故障转移
自动选择 = url-test,include-all-proxies=true,url=https://www.gstatic.com/generate_204,interval=300
故障转移 = fallback,include-all-proxies=true,url=https://www.gstatic.com/generate_204,interval=300

[Rule]
FINAL,Proxies
`;
  const config = parseYaml(buildClashConfig(scheme, airport));
  const groups = Object.fromEntries(config["proxy-groups"].map((group) => [group.name, group]));
  assert.ok(groups.Proxies);
  assert.ok(groups.Proxies.proxies.includes("自动选择"));
  assert.ok(groups.Proxies.proxies.includes("故障转移"));
  assert.ok(groups.Proxies.proxies.includes("美国节点 1"));
  assert.equal(groups["自动选择"].type, "url-test");
  assert.equal(groups["故障转移"].type, "fallback");
  assert.ok(config.rules.includes("MATCH,MW-FINAL"));
});

test("Shadowrocket FINAL uses MW-FINAL with Proxies first and DIRECT second", () => {
  const config = buildShadowrocketConfig(rules, airport);
  assert.match(config, /^MW-FINAL = select,Proxies,DIRECT$/m);
  assert.match(config, /^FINAL,MW-FINAL$/m);
  assert.match(config, /^DOMAIN-SUFFIX,bybdc6\.com,KR$/m);
  assert.doesNotMatch(config, /^Final\s*=/mi);
  assert.equal((config.match(/^FINAL,/gm) || []).length, 1);
});

test("Clash preserves automatic, failover and load-balance groups", () => {
  const config = parseYaml(buildClashConfig(strategyRules, airport));
  const groups = Object.fromEntries(config["proxy-groups"].map((group) => [group.name, group]));
  assert.equal(groups.Auto.type, "url-test");
  assert.equal(groups.Auto.url, "https://www.gstatic.com/generate_204");
  assert.equal(groups.Auto.interval, 300);
  assert.equal(groups.Auto.tolerance, 50);
  assert.equal(groups.Failover.type, "fallback");
  assert.equal(groups.Balance.type, "load-balance");
  assert.equal(groups.Balance.strategy, "consistent-hashing");
  assert.ok(!groups.Auto.proxies.includes("DIRECT"));
  assert.ok(!groups.Failover.proxies.includes("DIRECT"));
  assert.ok(!groups.Balance.proxies.includes("DIRECT"));
});

test("DIRECT is last in ordinary groups and excluded from health candidates", () => {
  const scheme = `
[Proxy Group]
Proxies = select,DIRECT,US,自动选择
自动选择 = url-test,include-all-proxies=true,DIRECT,url=https://www.gstatic.com/generate_204

[Rule]
FINAL,Proxies
`;
  const config = parseYaml(buildClashConfig(scheme, airport));
  const groups = Object.fromEntries(config["proxy-groups"].map((group) => [group.name, group]));
  assert.equal(groups.Proxies.proxies.at(-1), "DIRECT");
  assert.ok(!groups["自动选择"].proxies.includes("DIRECT"));

  const shadowrocket = buildShadowrocketConfig(scheme, airport);
  assert.match(shadowrocket, /^Proxies = select,.*自动选择,DIRECT$/m);
  assert.doesNotMatch(shadowrocket, /^自动选择 = url-test,.*DIRECT/m);
});

test("Shadowrocket preserves automatic and failover group types", () => {
  const config = buildShadowrocketConfig(strategyRules, airport);
  assert.match(config, /^Auto = url-test,/m);
  assert.match(config, /^Failover = fallback,/m);
  assert.match(config, /^Balance = load-balance,/m);
  assert.doesNotMatch(config, /^Auto = .*DIRECT/m);
  assert.doesNotMatch(config, /^Failover = .*DIRECT/m);
  assert.doesNotMatch(config, /^Balance = .*DIRECT/m);
});

test("Shadowrocket embeds the subscription remark as the config name", () => {
  const config = buildShadowrocketConfig(rules, airport, {}, "MWPRO", "耗子专用");
  assert.match(config, /^#!name=耗子专用$/m);
});

test("scheme names isolate generated Clash and Shadowrocket group names", () => {
  const clash = parseYaml(buildClashConfig(rules, airport, {}, "耗子专属"));
  const clashNames = clash["proxy-groups"].map((group) => group.name);
  assert.ok(clashNames.includes("耗子专属 · Proxies"));
  assert.ok(clashNames.includes("耗子专属 · KR"));
  assert.ok(clash.rules.includes("MATCH,耗子专属 · MW-FINAL"));
  assert.ok(clash.rules.includes("DOMAIN-SUFFIX,bybdc6.com,耗子专属 · KR"));

  const shadowrocket = buildShadowrocketConfig(rules, airport, {}, "耗子专属");
  assert.match(shadowrocket, /^耗子专属 · Proxies = select,/m);
  assert.match(shadowrocket, /^耗子专属 · KR = select,/m);
  assert.match(shadowrocket, /^FINAL,耗子专属 · MW-FINAL$/m);
  assert.match(shadowrocket, /^DOMAIN-SUFFIX,bybdc6\.com,耗子专属 · KR$/m);
});

test("Rules-only Shadowrocket output keeps the fallback group without nodes", () => {
  const config = buildShadowrocketRulesConfig(rules, airport);
  assert.match(config, /^MW-FINAL = select,Proxies,DIRECT$/m);
  assert.match(config, /^FINAL,MW-FINAL$/m);
  assert.doesNotMatch(config, /^\[Proxy\]$/m);
});

test("Flower Clash source becomes a rules-only default scheme", () => {
  const config = buildShadowrocketRuleConfigFromClash(flowerRules);
  assert.match(config, /^#!name=花云默认规则$/m);
  assert.match(config, /^Proxies = select,include-all-proxies=true,DIRECT$/m);
  assert.match(config, /^韩国 = select,Proxies,include-all-proxies=true,policy-regex-filter=韩国\|Korea$/m);
  assert.match(config, /^RULE-SET,https:\/\/rules\.example\/social\.yaml,Proxies$/m);
  assert.match(config, /^DOMAIN-SUFFIX,kr\.example,韩国$/m);
  assert.match(config, /^FINAL,Proxies$/m);
  assert.doesNotMatch(config, /^\[Proxy\]$/m);
  assert.doesNotMatch(config, /^proxies:/m);
});

test("Merged outputs preserve each airport's original proxy server", () => {
  const clash = parseYaml(buildClashConfig(rules, kqsAirport));
  const clashKqs = clash.proxies.find((proxy) => proxy.name === "VIP 香港 01");
  const clashFlower = clash.proxies.find((proxy) => proxy.name === "花云香港 IEPL 1");
  assert.equal(clashKqs.server, "kqs-hk.kunlun03dns.com");
  assert.equal(clashFlower.server, "flower.example.com");
  assert.deepEqual(clash.dns["proxy-server-nameserver"], [
    "https://kqs-resolver.example/dns-query",
    "223.5.5.5",
  ]);
  assert.deepEqual(clash.dns["proxy-server-nameserver-policy"]["+.kunlun03dns.com"], [
    "https://kqs-resolver.example/dns-query",
  ]);
  assert.equal(clash.dns["nameserver-policy"], undefined);
  assert.ok(!clash.dns["fake-ip-filter"].includes("*"));
  assert.ok(clash.dns["fake-ip-filter"].includes("+.lan"));
  assert.ok(clash.dns["fake-ip-filter"].includes("+.local"));

  const shadowrocket = buildShadowrocketConfig(rules, kqsAirport, { "kqs-hk.kunlun03dns.com": "54.95.1.133" });
  assert.match(shadowrocket, /^VIP 香港 01=ss,kqs-hk\.kunlun03dns\.com,25101,/m);
  assert.match(shadowrocket, /^花云香港 IEPL 1=ss,flower\.example\.com,443,/m);
  assert.match(shadowrocket, /^use-local-host-item-for-proxy = true$/m);
  assert.match(shadowrocket, /^kqs-hk\.kunlun03dns\.com = 54\.95\.1\.133$/m);
  assert.doesNotMatch(shadowrocket, /^dns-server = .*kqs-resolver\.example/m);
});

test("Shadowrocket prefers a native source when duplicate airport nodes exist", () => {
  const nativeKqs = `
ss://YWVzLTI1Ni1nY206dGVzdC1rcXM=@kqs-hk.kunlun03dns.com:25101#VIP%20%E9%A6%99%E6%B8%AF%2001
`;
  const config = buildShadowrocketConfig(rules, [kqsAirport, nativeKqs]);
  assert.match(config, /^VIP 香港 01=ss,kqs-hk\.kunlun03dns\.com,25101,encrypt-method=aes-256-gcm,password=test-kqs$/m);
  assert.doesNotMatch(config, /^VIP 香港 01=.*udp-relay=true$/m);
  assert.doesNotMatch(config, /^dns-server = .*kqs-resolver\.example/m);
});

test("Clash replaces hostname-based airport proxies with source-resolved addresses", () => {
  const clash = parseYaml(buildClashConfig(rules, kqsAirport, {
    "kqs-hk.kunlun03dns.com": "15.152.30.113",
  }));
  const kqs = clash.proxies.find((proxy) => proxy.name === "VIP 香港 01");
  const flower = clash.proxies.find((proxy) => proxy.name === "花云香港 IEPL 1");
  assert.equal(kqs.server, "15.152.30.113");
  assert.equal(flower.server, "flower.example.com");
});

test("Shadowrocket preserves an airport's UDP relay setting", () => {
  const directKqs = `
ss://YWVzLTI1Ni1nY206dGVzdC1rcXM=@kqs-hk.kunlun03dns.com:25101#VIP%20%E9%A6%99%E6%B8%AF%2001
`;
  const config = buildShadowrocketConfig(rules, directKqs);
  assert.match(config, /^VIP 香港 01=ss,kqs-hk\.kunlun03dns\.com,25101,encrypt-method=aes-256-gcm,password=test-kqs$/m);
  assert.doesNotMatch(config, /^VIP 香港 01=.*udp-relay=true$/m);
});

test("Shadowrocket strips Clash-only KQS UDP and DNS fallback flags", () => {
  const kqsClash = `
dns:
  proxy-server-nameserver:
    - https://20.247.42.211:36290/dns-query/clash?site=kuaiqiangshou
proxies:
  - name: VIP 香港 01
    type: ss
    server: kqs-hk.kunlun03dns.com
    port: 25101
    cipher: aes-256-gcm
    password: test-kqs
    udp: true
`;
  const config = buildShadowrocketConfig(rules, kqsClash);
  assert.match(config, /^VIP 香港 01=ss,kqs-hk\.kunlun03dns\.com,25101,/m);
  assert.doesNotMatch(config, /^VIP 香港 01=.*udp-relay=true$/m);
  assert.doesNotMatch(config, /^dns-server = .*20\.247\.42\.211/m);
});

test("Shadowrocket does not force a public DNS address when the airport resolver is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("", { status: 503 });
  try {
    const mappings = await resolveAirportProxyHosts([kqsAirport]);
    assert.deepEqual(mappings, {});
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("client visibility hides a group and removes all dangling references", () => {
  const source = `[Proxy Group]\nProxies = select,US,CN,DIRECT\nFinal = select,Proxies,DIRECT\nCN = select,DIRECT\nUS = select,美国节点\n\n[Rule]\nDOMAIN-SUFFIX,cn.example,CN\nFINAL,Final\n`;
  const filtered = filterHiddenGroups(source, ["CN"]);
  assert.match(filtered, /Proxies = select,US,DIRECT/);
  assert.doesNotMatch(filtered, /^CN\s*=/m);
  assert.match(filtered, /DOMAIN-SUFFIX,cn\.example,DIRECT/);
  assert.match(filtered, /FINAL,Final/);
});

test("hiding the final group redirects FINAL to the visible proxies group", () => {
  const source = `[Proxy Group]\nProxies = select,US,DIRECT\nFinal = select,Proxies,DIRECT\nUS = select,美国节点\n\n[Rule]\nFINAL,Final\n`;
  const filtered = filterHiddenGroups(source, ["Final"]);
  assert.doesNotMatch(filtered, /^Final\s*=/m);
  assert.match(filtered, /FINAL,Proxies/);
});
