import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const androidPatch = fs.readFileSync(new URL("../scripts/patch-android.js", import.meta.url), "utf8");
const backupContract = fs.readFileSync(new URL("../docs/BACKUP-SERVER-CONTRACT.md", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("PMS backup uses app-private storage as the primary destination", () => {
  assert.match(androidPatch, /new java\.io\.File\(getFilesDir\(\), "backups\/pms"\)/);
  assert.match(androidPatch, /writePrivateBackup\(name,payload\)/);
  assert.match(androidPatch, /readLatestPrivateBackup\(excluded\)/);
  assert.match(androidPatch, /for \(int i=7;i<files\.length;i\+\+\)/);
});

test("Google Drive and shared SAF folders have independent persisted grants", () => {
  assert.match(androidPatch, /backup_tree_uri/);
  assert.match(androidPatch, /shared_tree_uri/);
  assert.match(androidPatch, /readLatestBackupFromFolder\(prefs\.getString\("shared_tree_uri"/);
  assert.match(html, /pickDir\('shared'\)/);
  assert.match(html, /Google Drive · Optional/);
  assert.match(html, /Shared Folder \/ SAF Policy/);
});

test("owner server credentials use Android Keystore and HTTPS only", () => {
  assert.match(androidPatch, /AndroidKeyStore/);
  assert.match(androidPatch, /AES\/GCM\/NoPadding/);
  assert.match(androidPatch, /"https"\.equalsIgnoreCase/);
  assert.match(androidPatch, /setInstanceFollowRedirects\(false\)/);
  assert.match(androidPatch, /downloadLatestBackupFromServer/);
  assert.match(backupContract, /POST to the configured endpoint/);
  assert.match(backupContract, /GET from the configured endpoint/);
});

test("provider controls are capability-gated and folio auto-settlement stays disabled", () => {
  assert.match(html, /caps\.includes\('provider\.management'\)/);
  const gate = fs.readFileSync(new URL("../src/payments/settlement-gate.mjs", import.meta.url), "utf8");
  assert.match(gate, /AUTO_FOLIO_SETTLEMENT_ENABLED = false/);
});


test("all new backup destinations receive a portable AES-256-GCM envelope", () => {
  assert.match(html, /AURELIA-PMS-ENCRYPTED-BACKUP/);
  assert.match(html, /AES-256-GCM/);
  assert.match(html, /PBKDF2-HMAC-SHA256/);
  assert.match(html, /BACKUP_KDF_ITERATIONS=600000/);
  assert.match(html, /encryptBackupPayload\(snap\.payload,snap\.name\)/);
  assert.match(html, /decryptBackupPayload\(payload,fileName\)/);
  assert.match(html, /setupBackupRecoveryPassword/);
  assert.match(androidPatch, /AURELIA-PMS-ENCRYPTED-BACKUP/);
  assert.match(backupContract, /encrypted PMS backup envelope/);
});
