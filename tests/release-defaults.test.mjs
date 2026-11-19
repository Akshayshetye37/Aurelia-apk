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
  assert.match(profile, /uiCutover\s*:\s*false/);
  assert.match(profile, /cloudSync\s*:\s*false/);
  assert.match(profile, /sync\s*:\s*false/);
  assert.match(profile, /gatewayPayments\s*:\s*false/);
  assert.match(profile, /payBridge\s*:\s*false/);
  assert.match(profile, /ccavenue\s*:\s*false/);
});

test("release profile remains immutable and exposes no enabled payment providers", () => {
  const profile = releaseProfile(html);
  assert.match(html, /window\.AURELIA_LOCAL_ONLY_RELEASE\s*=\s*Object\.freeze\(/);
  assert.match(profile, /enabledProviders\s*:\s*Object\.freeze\(\s*\[\s*\]\s*\)/);
  assert.doesNotMatch(profile, /enabledProviders\s*:\s*Object\.freeze\(\s*\[[^\]]+\]/);
});

test("gateway and Pay Bridge entry points fail closed when R1 flags are OFF", () => {
  assert.match(html, /AURELIA_LOCAL_ONLY_RELEASE\?\.gatewayPayments\s*!==\s*true/, "gateway checkout must be blocked");
  assert.match(html, /AURELIA_LOCAL_ONLY_RELEASE\?\.payBridge\s*!==\s*true/, "Pay Bridge actions must be blocked");
});
