import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGate3Evidence } from '../scripts/gates/validate-gate3-evidence.mjs';

const sha = 'a'.repeat(40);
const hash = 'b'.repeat(64);
const details = { candidateSha: sha, stagingProjectId: 'aurelia-stage-12345', productionProjectId: 'aurelia-prod-12345', stagingRunId: 12345, apkSha256: hash, testApkSha256: hash, signerSha256: hash, stagingDeployment: 'QUALIFIED', apkBuildAndSigning: 'QUALIFIED', callables: ['alpha'] };
const deployedInventory = { candidateSha: sha, inventory: ['alpha'], deployed: ['alpha'], reconciled: true };
const probes = [
  { callable: 'alpha', case: 'no App Check token', status: 401 },
  { callable: 'alpha', case: 'invalid App Check token', status: 403 },
];

test('valid staging evidence does not infer physical qualification', () => {
  const status = validateGate3Evidence({ probes, details, candidateSha: sha, deployedInventory });
  assert.equal(status.APPCHECK_NEGATIVE_PROBES, 'QUALIFIED');
  assert.equal(status.PHYSICAL_SMS_RECOVERY, 'NOT QUALIFIED');
  assert.equal(status.GATE_3_OVERALL, 'NOT QUALIFIED');
});
test('rejects deployed inventory SHA mismatch', () => assert.throws(() => validateGate3Evidence({ probes, details, candidateSha: sha, deployedInventory: { ...deployedInventory, candidateSha: 'c'.repeat(40) } }), /not bound to candidate SHA/));
test('rejects unreconciled deployed inventory', () => assert.throws(() => validateGate3Evidence({ probes, details, candidateSha: sha, deployedInventory: { ...deployedInventory, reconciled: false } }), /not bound to candidate SHA/));
test('rejects missing test APK and signer hashes', () => {
  assert.throws(() => validateGate3Evidence({ probes, details: { ...details, testApkSha256: '' }, candidateSha: sha, deployedInventory }), /testApkSha256/);
  assert.throws(() => validateGate3Evidence({ probes, details: { ...details, signerSha256: '' }, candidateSha: sha, deployedInventory }), /signerSha256/);
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
test('physical matrix with incomplete cases cannot qualify', () => { const matrix = { candidateSha: sha, status: 'QUALIFIED', device: { model: 'test device', androidApi: 34, apkSha256: hash }, cases: { 'G3-01': 'PASS' }, signoff: { reviewer: 'reviewer', signedAt: '2026-11-21T00:00:00Z', commit: sha } }; const status = validateGate3Evidence({ probes, details, candidateSha: sha, controlSha: sha, physicalMatrix: matrix, deployedInventory }); assert.equal(status.GATE_3_OVERALL, 'NOT QUALIFIED'); });
test('physical matrix requires exact candidate SHA and signoff', () => {
  const matrix = { candidateSha: sha, status: 'QUALIFIED', device: { model: 'test device', androidApi: 34, apkSha256: hash }, cases: Object.fromEntries(['G3-01','G3-02','G3-03','G3-04','G3-05','G3-06','G3-07','G3-08','G3-09','G3-10'].map(id => [id, 'PASS'])), signoff: { reviewer: 'reviewer', signedAt: '2026-11-21T00:00:00Z', commit: sha } };
  const status = validateGate3Evidence({ probes, details, candidateSha: sha, controlSha: sha, physicalMatrix: matrix, deployedInventory });
  assert.equal(status.PHYSICAL_SMS_RECOVERY, 'QUALIFIED');
  assert.equal(status.GATE_3_OVERALL, 'QUALIFIED');
});
