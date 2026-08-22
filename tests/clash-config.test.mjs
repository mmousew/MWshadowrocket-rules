import assert from "node:assert/strict";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import {
  buildClashConfig,
  buildShadowrocketConfig,
  buildShadowrocketRulesConfig,
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
