import assert from "node:assert/strict";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import {
  buildClashConfig,
  buildShadowrocketConfig,
  buildShadowrocketRulesConfig,
  resolveAirportProxyHosts,
} from "../app/lib/clash-config.ts";

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
  assert.match(shadowrocket, /^dns-server = https:\/\/kqs-resolver\.example\/dns-query,223\.5\.5\.5$/m);
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
