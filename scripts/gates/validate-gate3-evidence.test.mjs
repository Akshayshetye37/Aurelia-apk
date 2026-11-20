import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGate3Evidence } from './validate-gate3-evidence.mjs';

const sha = 'a'.repeat(40);
const hash = 'b'.repeat(64);
const details = { candidateSha: sha, apkSha256: hash, testApkSha256: hash, signerSha256: hash, stagingDeployment: 'QUALIFIED', apkBuildAndSigning: 'QUALIFIED', callables: ['alpha'] };
const deployedInventory = { candidateSha: sha, inventory: ['alpha'], deployed: ['alpha'], reconciled: true };
const probes = [
  { callable: 'alpha', case: 'no App Check token', status: 401 },
  { callable: 'alpha', case: 'invalid App Check token', status: 403 },
];

test('valid staging evidence is accepted but physical qualification is not inferred', () => {
  const status = validateGate3Evidence({ probes, details, candidateSha: sha, deployedInventory });
  assert.equal(status.APPCHECK_NEGATIVE_PROBES, 'QUALIFIED');
  assert.equal(status.PHYSICAL_SMS_RECOVERY, 'NOT QUALIFIED');
  assert.equal(status.GATE_3_OVERALL, 'NOT QUALIFIED');
});

test('rejects missing deployed inventory evidence', () => assert.throws(() => validateGate3Evidence({ probes, details, candidateSha: sha }), /deployed callable inventory evidence is missing/));
test('rejects zero probes', () => assert.throws(() => validateGate3Evidence({ probes: [], details, candidateSha: sha }), /at least one probe/));
test('rejects missing probe type', () => assert.throws(() => validateGate3Evidence({ probes: [probes[0]], details, candidateSha: sha }), /missing probe/));
test('rejects non-401/403 status', () => assert.throws(() => validateGate3Evidence({ probes: [{ ...probes[0], status: 200 }, probes[1]], details, candidateSha: sha }), /invalid probe result/));
test('rejects candidate SHA mismatch', () => assert.throws(() => validateGate3Evidence({ probes, details: { ...details, candidateSha: 'c'.repeat(40) }, candidateSha: sha }), /candidate SHA mismatch/));
test('rejects missing callable inventory', () => assert.throws(() => validateGate3Evidence({ probes, details: { ...details, callables: undefined }, candidateSha: sha }), /callable inventory is missing/));
test('rejects missing APK hash', () => assert.throws(() => validateGate3Evidence({ probes, details: { ...details, apkSha256: '' }, candidateSha: sha }), /apkSha256/));
test('rejects unexplained exclusions', () => assert.throws(() => validateGate3Evidence({ probes, details: { ...details, excluded: [{ probe: 'x' }] }, candidateSha: sha }), /exclusion must include/));
test('rejects duplicate probes', () => assert.throws(() => validateGate3Evidence({ probes: [...probes, probes[0]], details, candidateSha: sha }), /duplicate probe/));
test('physical matrix requires exact SHA and signed reviewer fields', () => {
  const matrix = { candidateSha: sha, status: 'QUALIFIED', signoff: { reviewer: 'reviewer', signedAt: '2026-11-21T00:00:00Z', commit: 'c'.repeat(40) } };
  const status = validateGate3Evidence({ probes, details, candidateSha: sha, physicalMatrix: matrix, deployedInventory });
  assert.equal(status.PHYSICAL_SMS_RECOVERY, 'QUALIFIED');
  assert.equal(status.GATE_3_OVERALL, 'QUALIFIED');
});
