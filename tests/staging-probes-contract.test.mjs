import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/gates/staging-probes.mjs');
const base = {
  STAGING_PROJECT_ID: 'aurelia-stage-12345',
  PRODUCTION_PROJECT_ID: 'aurelia-prod-12345',
  STAGING_REGION: 'asia-south1',
  STAGING_FUNCTIONS_BASE_URL: 'https://asia-south1-aurelia-stage-12345.cloudfunctions.net',
};
const expected = [
  'createRecoveryAttestationChallenge', 'verifyRecoveryDeviceAttestation',
  'registerRecoveryPhone', 'exchangeOwnerEmailLink', 'confirmRecoveryOwnerBinding',
  'registerRecoveryOwnerDevice', 'acknowledgeRecoveryOwnerAlert', 'issueRecoveryGrant',
  'consumeRecoveryGrant', 'cancelRecoveryRequest', 'cancelRecoveryPhoneChange',
  'activateRecoveryPhoneChange',
].join(',');
function run(callables) {
  return spawnSync(process.execPath, [script], {
    env: { ...process.env, ...base, RECOVERY_CALLABLES: callables },
    encoding: 'utf8', timeout: 5000,
  });
}
test('Gate 3 rejects an incomplete recovery callable inventory before network access', () => {
  const result = run('issueRecoveryGrant');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pinned 12-callable recovery surface/);
});
test('Gate 3 rejects duplicate recovery callables before network access', () => {
  const result = run(expected + ',issueRecoveryGrant');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pinned 12-callable recovery surface/);
});
test('Gate 3 rejects non-HTTPS callable origins before network access', () => {
  const result = spawnSync(process.execPath, [script], {
    env: { ...process.env, ...base, STAGING_FUNCTIONS_BASE_URL: base.STAGING_FUNCTIONS_BASE_URL.replace('https:', 'http:'), RECOVERY_CALLABLES: expected },
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HTTPS/);
});
