import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const requiredFalseFlags = ["uiCutover", "cloudSync", "sync", "gatewayPayments", "payBridge", "ccavenue"];

function releaseProfile(source) {
  const match = source.match(/window\.AURELIA_LOCAL_ONLY_RELEASE\s*=\s*Object\.freeze\(\s*\{([\s\S]*?)\}\s*\)/);
  assert.ok(match, "immutable local-only release profile must exist");
  return match[1];
}

test("R1 release profile exists and all privileged capabilities default OFF", () => {
  const profile = releaseProfile(html);
  for (const flag of requiredFalseFlags) {
    assert.match(profile, new RegExp(`(?:^|[,\\s])${flag}\\s*:\\s*false(?:\\s*[,}]|$)`), `${flag} must explicitly default to false`);
  }
  assert.match(profile, /enabledProviders\s*:\s*Object\.freeze\(\s*\[\s*\]\s*\)/, "provider allow-list must be empty");
});

test("gateway and Pay Bridge entry points fail closed when R1 flags are OFF", () => {
  assert.match(html, /AURELIA_LOCAL_ONLY_RELEASE\?\.gatewayPayments\s*!==\s*true/, "gateway checkout must be blocked");
  assert.match(html, /AURELIA_LOCAL_ONLY_RELEASE\?\.payBridge\s*!==\s*true/, "Pay Bridge actions must be blocked");
});
