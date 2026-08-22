import assert from "node:assert/strict";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import {
  buildClashConfig,
  buildShadowrocketRuleConfigFromClash,
  buildShadowrocketConfig,
  buildShadowrocketRulesConfig,
  resolveAirportProxyHosts,
} from "../app/lib/clash-config.ts";

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

test("Clash FINAL uses a dedicated fallback group with PROXY as default", () => {
  const config = parseYaml(buildClashConfig(rules, airport));
  const finalGroups = config["proxy-groups"].filter((group) => group.name === "MW-FINAL");
  assert.equal(finalGroups.length, 1);
  assert.deepEqual(finalGroups[0].proxies, ["PROXY", "DIRECT"]);
  assert.ok(config.rules.includes("MATCH,MW-FINAL"));
  assert.ok(config.rules.includes("DOMAIN-SUFFIX,bybdc6.com,KR"));
  assert.ok(!config.rules.some((rule) => /^MATCH,Final$/i.test(rule)));
});

test("Shadowrocket FINAL uses MW-FINAL with Proxies first and DIRECT second", () => {
  const config = buildShadowrocketConfig(rules, airport);
  assert.match(config, /^MW-FINAL = select,Proxies,DIRECT$/m);
  assert.match(config, /^FINAL,MW-FINAL$/m);
  assert.match(config, /^DOMAIN-SUFFIX,bybdc6\.com,KR$/m);
  assert.doesNotMatch(config, /^Final\s*=/mi);
  assert.equal((config.match(/^FINAL,/gm) || []).length, 1);
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
