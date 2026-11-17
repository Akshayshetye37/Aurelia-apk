import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProductionSmokeBinding, validateReleaseSmokeInputs } from '../scripts/gates/release-smoke-schema.mjs';

const sha = 'a'.repeat(40), hash = 'b'.repeat(64), testHash = 'c'.repeat(64), signer = 'd'.repeat(64);
const now = Date.parse('2026-11-17T10:00:00.000Z');
const fixture = () => {
  const release = { productionProjectId: 'aurelia-prod-12345', activeKid: 'prod-kid-1', packageLockSha256: 'e'.repeat(64), apkSha256: hash, testApkSha256: testHash, signerSha256: signer };
  return {
    metadata: { candidateSha: sha, candidateBranch: 'work/p0-storage-hardening', ...release },
    attestedRelease: { ...release },
    qualification: { candidateSha: sha, status: 'QUALIFIED_FOR_RELEASE_REVIEW', productionRecoveryEnabled: false, productionRelease: { ...release }, device: { deviceLabel: 'AURELIA-PIXEL8', deviceModel: 'Pixel 8', androidVersion: '15', hardwareSecurityLevel: 'TEE' } },
    currentAudit: { project: release.productionProjectId, productionRecoveryEnabled: false, recoverySigningKeyId: release.activeKid, problems: [], checkedAt: new Date(now - 1000).toISOString() },
    candidateSha: sha, candidateBranch: 'work/p0-storage-hardening', releaseCommitSha: sha, deviceLabel: 'AURELIA-PIXEL8', now,
  };
};

test('post-release smoke input accepts a production release tied to Gate 6 and a fresh OFF audit', () => {
  assert.equal(validateReleaseSmokeInputs({ repo: 'owner/repo', controlBranch: 'integration/ledger-patch',
    candidateBranch: 'work/p0-storage-hardening', candidateSha: sha, gate6RunId: '123456', releaseTag: 'v1.2.3' }), true);
  assert.equal(validateProductionSmokeBinding(fixture()), true);
});

test('post-release smoke input rejects unsafe run IDs, tags and candidate refs', () => {
  for (const bad of [
    { repo: 'owner/repo', controlBranch: 'main', candidateBranch: 'work/candidate', candidateSha: sha, gate6RunId: '0', releaseTag: 'v1' },
    { repo: 'owner/repo', controlBranch: 'main', candidateBranch: 'work/candidate', candidateSha: sha, gate6RunId: '12', releaseTag: '../main' },
    { repo: 'owner/repo', controlBranch: 'main', candidateBranch: '../main', candidateSha: sha, gate6RunId: '12', releaseTag: 'v1' },
  ]) assert.throws(() => validateReleaseSmokeInputs(bad));
});

test('post-release smoke rejects a different published commit, mismatched APK, stale audit or enabled recovery', () => {
  const wrongCommit = fixture(); wrongCommit.releaseCommitSha = 'e'.repeat(40);
  assert.throws(() => validateProductionSmokeBinding(wrongCommit), /exact candidate SHA/);
  const wrongApk = fixture(); wrongApk.metadata.apkSha256 = 'f'.repeat(64);
  assert.throws(() => validateProductionSmokeBinding(wrongApk), /metadata differs/);
  const stale = fixture(); stale.currentAudit.checkedAt = new Date(now - 2 * 60 * 60 * 1000).toISOString();
  assert.throws(() => validateProductionSmokeBinding(stale), /older than one hour/);
  const enabled = fixture(); enabled.currentAudit.productionRecoveryEnabled = true;
  assert.throws(() => validateProductionSmokeBinding(enabled), /recovery OFF/);
});
