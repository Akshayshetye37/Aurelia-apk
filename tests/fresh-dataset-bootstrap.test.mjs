import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

test("new operational dataset has a distinct key and retains the former key", () => {
  assert.match(html, /LEGACY_SK='aurelia_lodge_v2',SK='aurelia_pms_v3'/);
});

test("first-run bootstrap removes demo records and persists without migrating legacy data", () => {
  assert.match(html, /loadAll\(\);\s*\/\/ New installs use a clean PMS dataset[\s\S]*?if\(LOCAL_STATE_STATUS==='missing'\)\{demoGo\(true\);persist\(\);\}/);
  assert.match(html, /function demoGo\(silent=false\)/);
  assert.match(html, /S\.b=S\.b\.filter\(x=>!x\.demo\)/);
  assert.match(html, /S\.rooms=S\.rooms\.filter\(x=>!x\.demo\)/);
  assert.match(html, /S\.today=0/);
  assert.match(html, /S\.hist=\[0,0,0,0,0,0\]/);
});

test("fresh in-memory state contains no seeded guest bookings or historical takings", () => {
  assert.match(html, /b:\[\],t:\[\],g:\[\]/);
  assert.match(html, /today:0,hist:\[0,0,0,0,0,0\]/);
  assert.match(html, /exp:\[\],inv:\[\]/);
  assert.doesNotMatch(html, /Mosi lager|Seared Kafue bream|Fresh produce|Generator diesel/);
  assert.doesNotMatch(html, /B\('Mwila Chanda'/);
  assert.doesNotMatch(html, /B\('Amara Okafor'/);
  assert.doesNotMatch(html, /S\.b\[1\]\.pays/);
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


test("invalid saved state is quarantined and is not overwritten by fresh-install bootstrap", () => {
  assert.match(html, /LOCAL_STATE_STATUS='invalid'[\s\S]*?setItem\(SK\+'_recovery_quarantine_'/);
  assert.match(html, /function persist\(\)\{if\(RECOVERY_CHECK_PENDING\|\|\(LOCAL_STATE_STATUS==='invalid'&&!RESTORE_WRITE_ALLOWED\)\)return/);
  assert.match(html, /if\(LOCAL_STATE_STATUS==='missing'\)\{demoGo\(true\);persist\(\);\}/);
});

test("a complete backup restore is the only path allowed to replace quarantined state", () => {
  assert.match(html, /LOCAL_STATE_STATUS==='invalid'&&S\.rstMode==='export'[\s\S]*?record imports are blocked/);
  assert.match(html, /RESTORE_WRITE_ALLOWED=true;\s*persist\(\);[\s\S]*?LOCAL_STATE_STATUS='valid';RESTORE_WRITE_ALLOWED=false/);
  assert.match(html, /RESTORE_WRITE_ALLOWED=false;LOCAL_STATE_STATUS=priorLocalStatus/);
});


test("quarantined dataset displays a recovery action and warns that writes are blocked", () => {
  assert.match(html, /Saved PMS data is quarantined after a validation failure/);
  assert.match(html, /New changes are not being saved/);
  assert.match(html, /S\.tab='more';S\.sub='backup';render\(\)/);
});
