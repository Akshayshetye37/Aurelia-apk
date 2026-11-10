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

test("merchant credentials remain backend-only while local payments and folio interlocks stay safe", () => {
  assert.doesNotMatch(html, /Device-local Gateway Credential Vault|gatewayVaultSave|gatewayVaultRemove/);
  assert.match(html, /Google Secret Manager/);
  assert.match(html, /Optional trusted HTTPS backend/);
  assert.match(html, /window\.AndroidPaymentEngine/);
  assert.match(html, /secure native Android payment engine is not installed/);
  assert.doesNotMatch(html, /\+localGatewayAdminHtml\(\)\+/);
  const gate = fs.readFileSync(new URL("../src/payments/settlement-gate.mjs", import.meta.url), "utf8");
  assert.match(gate, /AUTO_FOLIO_SETTLEMENT_ENABLED = false/);
});


test("all new backup destinations receive a portable AES-256-GCM envelope", () => {
  assert.match(html, /AURELIA-PMS-ENCRYPTED-BACKUP/);
  assert.match(html, /AES-256-GCM/);
  assert.match(html, /PBKDF2-HMAC-SHA256/); // v1 restore compatibility only
  assert.match(html, /ARGON2ID/);
  assert.match(html, /BACKUP_ARGON2ID=Object\.freeze\(\{kdf:'ARGON2ID',memoryKiB:65536,iterations:3,parallelism:1\}\)/);
  assert.match(html, /BACKUP_V1_KDF_ITERATIONS=600000/);
  assert.match(html, /backup-key-wrap\\|v2\\|/);
  const argonBridge = fs.readFileSync(new URL("../src/storage/backup-crypto-bridge.mjs", import.meta.url), "utf8");
  assert.match(argonBridge, /from "hash-wasm"/);
  assert.match(argonBridge, /memorySize: parameters\.memoryKiB/);
  assert.match(html, /format:2/);
  assert.match(html, /encryptBackupPayload\(snap\.payload,snap\.name\)/);
  assert.match(html, /decryptBackupPayload\(payload,fileName\)/);
  assert.match(html, /manifest=\{formatVersion:2,name,kdf:BACKUP_ARGON2ID\.kdf,memoryKiB/);
  assert.match(html, /backup-v2\|\x27\+JSON\.stringify\(envelope\.manifest\)/);
  assert.match(html, /envelope\.v===2/);
  assert.match(html, /envelope\.kdf==='ARGON2ID'/);
  assert.match(html, /envelope\.v===1/);
  assert.match(html, /Backup manifest verification failed/);
  assert.match(html, /payloadBytes/);
  assert.match(html, /recordCounts/);
  assert.match(html, /setupBackupRecoveryPassword/);
  assert.match(androidPatch, /AURELIA-PMS-ENCRYPTED-BACKUP/);
  assert.match(backupContract, /encrypted PMS backup envelope/);
});


test('cached backup keys cannot bypass manifest hash, size and record-count verification', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /async function verifyBackupManifestPayload/);
  assert.match(html, /constantTimeHexEqual\(await sha256Hex\(decoded\),manifest\.payloadSha256\)/);
  assert.match(html, /if\(envelope\.v===2\)await verifyBackupManifestPayload\(decoded,envelope\.manifest\)/);
  assert.match(html, /finally\{cachedPlain\.fill\(0\)\}/);
  assert.match(html, /finally\{plain\.fill\(0\)\}/);
});
