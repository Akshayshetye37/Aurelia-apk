import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Gate 3 records and publishes the exact dependency lock used for its staging APK', () => {
  const staging = read('.github/workflows/recovery-staging-deploy.yml');
  const gate3 = read('.github/workflows/gate-3-real-sms-staging.yml');
  assert.match(staging, /package-lock\.json/);
  assert.match(gate3, /packageLockSha256/);
  assert.match(gate3, /aurelia-recovery-staging-apk-/);
});

test('Gate 6 builds the production APK from Gate 3 lock and binds its signer to Gate 5', () => {
  const gate6 = read('.github/workflows/gate-6-release-signoff.yml');
  const verifier = read('scripts/gates/verify-qualification.mjs');
  const audit = read('scripts/gates/audit-production.mjs');
  assert.match(gate6, /fetch-gate3-build-lock\.mjs/);
  assert.match(gate6, /npm ci --no-audit --no-fund/);
  assert.match(gate6, /PRODUCTION_GOOGLE_SERVICES_JSON_BASE64/);
  assert.match(gate6, /PRODUCTION_KEYSTORE_BASE64/);
  assert.match(gate6, /gate-6-production-release/);
  assert.match(verifier, /productionRelease\.packageLockSha256 !== records\['3'\]\.details\.packageLockSha256/);
  assert.match(verifier, /productionRelease\.signerSha256/);
  assert.match(audit, /validateProductionSigningKeyId/);
});

test('post-release smoke re-audits production and verifies the published APK on the approved handset', () => {
  const workflow = read('.github/workflows/production-release-smoke.yml');
  const verifier = read('scripts/gates/verify-production-release-smoke-input.mjs');
  assert.match(workflow, /environment: recovery-production-audit/);
  assert.match(workflow, /environment: recovery-device/);
  assert.match(workflow, /production-release-smoke-input\.mjs/);
  assert.match(workflow, /OtpRecoverySqlCipherInstrumentedTest/);
  assert.match(workflow, /scan-logs\.mjs/);
  assert.match(verifier, /gh.*release/);
  assert.match(verifier, /productionRecoveryEnabled/);
});

test('Gate 4 and Gate 6 explicitly qualify one handset and reject unrecorded manual cases', () => {
  const schema = read('scripts/gates/device-attestation-schema.mjs');
  const gate4 = read('docs/GATE-4-PHYSICAL-DEVICE-RECOVERY-QUALIFICATION.md');
  const gate6 = read('docs/GATE-6-RELEASE-SIGNOFF.md');
  assert.match(schema, /notificationPermissionOffBlocksRecovery/);
  assert.match(schema, /ownerDeviceOfflineBlocksRecovery/);
  assert.match(schema, /noIndependentOwnerDeviceBlocksRecovery/);
  assert.match(schema, /simSwapRejected/);
  assert.match(schema, /hardwareBackedAttestationVerified/);
  assert.match(schema, /passkeyAssertionVerified/);
  assert.match(gate4, /exactly one approved physical handset/);
  assert.match(gate6, /one handset approved for this release/);
});
