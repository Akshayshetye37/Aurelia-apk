import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

test("new operational dataset has a distinct key and retains the former key", () => {
  assert.match(html, /LEGACY_SK='aurelia_lodge_v2',SK='aurelia_pms_v3'/);
});

test("first-run bootstrap removes demo records and persists without migrating legacy data", () => {
  assert.match(html, /loadAll\(\);\s*\/\/ New installs use a clean PMS dataset[\s\S]*?if\(LOCAL_STATE_STATUS!=='valid'\)\{demoGo\(true\);persist\(\);\}/);
  assert.match(html, /function demoGo\(silent=false\)/);
  assert.match(html, /S\.b=S\.b\.filter\(x=>!x\.demo\)/);
  assert.match(html, /S\.rooms=S\.rooms\.filter\(x=>!x\.demo\)/);
  assert.match(html, /S\.today=0/);
  assert.match(html, /S\.hist=\[0,0,0,0,0,0\]/);
});

test("legacy export reads and downloads the original JSON without mutating the archive", () => {
  assert.match(html, /function exportLegacyPmsArchive\(\)/);
  assert.match(html, /const raw=\(window\.__aureliaStorage\|\|localStorage\)\.getItem\(LEGACY_SK\)/);
  assert.match(html, /new Blob\(\[raw\],\{type:'application\/json'\}\)/);
  assert.match(html, /a\.download='aurelia-legacy-pms-v2-archive\.json'/);
});

test("reset targets only the new operational namespace", () => {
  assert.match(html, /function resetAll\(\)\{try\{\(window\.__aureliaStorage\|\|localStorage\)\.removeItem\(SK\)\}catch\(e\)\{\}location\.reload\(\)\}/);
  assert.doesNotMatch(html, /removeItem\(LEGACY_SK\)/);
});

test("default payment method catalogue does not contain unrelated mobile-money rails", () => {
  assert.match(html, /PM=\['Cash','UPI','Card','Bank transfer','NEFT','RTGS','IMPS'\]/);
  assert.doesNotMatch(html, /PM=\['Cash','MTN MoMo','Airtel Money','Zamtel'/);
});
