import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fail, sha256File, verifyBundle } from './lib.mjs';
import { validateProductionSmokeBinding, validateReleaseSmokeInputs } from './release-smoke-schema.mjs';

const { REPO, CONTROL_BRANCH, CANDIDATE_BRANCH, CANDIDATE_SHA, GATE6_RUN_ID, RELEASE_TAG } = process.env;
try {
  validateReleaseSmokeInputs({ repo: REPO, controlBranch: CONTROL_BRANCH, candidateBranch: CANDIDATE_BRANCH,
    candidateSha: CANDIDATE_SHA, gate6RunId: GATE6_RUN_ID, releaseTag: RELEASE_TAG });
} catch (error) { fail(error.message); }

const gate6Record = verifyBundle({
  repo: REPO, runId: GATE6_RUN_ID, gate: '6',
  workflowFile: 'gate-6-release-signoff.yml',
  controlBranch: CONTROL_BRANCH, dir: 'gate6-evidence',
});
if (gate6Record.candidateSha !== CANDIDATE_SHA) fail('Gate 6 evidence belongs to a different candidate');
const qualificationPath = 'gate6-evidence/evidence/qualification-result.json';
const attestedReleasePath = 'gate6-evidence/evidence/production-release.json';
if (!fs.existsSync(qualificationPath) || !fs.existsSync(attestedReleasePath)) fail('Gate 6 qualification or production release evidence is missing');
const qualification = JSON.parse(fs.readFileSync(qualificationPath, 'utf8'));
const attestedRelease = JSON.parse(fs.readFileSync(attestedReleasePath, 'utf8'));


fs.rmSync('gate6-production-release', { recursive: true, force: true });
execFileSync('gh', ['run', 'download', GATE6_RUN_ID, '-R', REPO, '-n', 'gate-6-production-release', '-D', 'gate6-production-release'], { stdio: 'inherit' });
const metadata = JSON.parse(fs.readFileSync('gate6-production-release/production-release.json', 'utf8'));
const currentAudit = JSON.parse(fs.readFileSync('production-audit/production-audit.json', 'utf8'));
if (currentAudit.project !== metadata.productionProjectId ||
    currentAudit.productionRecoveryEnabled !== false ||
    currentAudit.recoverySigningKeyId !== metadata.activeKid ||
    !Array.isArray(currentAudit.problems) || currentAudit.problems.length !== 0 ||
    !currentAudit.checkedAt || Date.now() - Date.parse(currentAudit.checkedAt) > 60 * 60 * 1000) {
  fail('fresh production audit does not confirm recovery OFF and the matching signing key ID');
}
const releaseCommit = JSON.parse(execFileSync('gh', ['api', `repos/${REPO}/commits/${encodeURIComponent(RELEASE_TAG)}`], { encoding: 'utf8' })).sha;
try {
  validateProductionSmokeBinding({
    metadata, attestedRelease, qualification, currentAudit,
    candidateSha: CANDIDATE_SHA, candidateBranch: CANDIDATE_BRANCH,
    releaseCommitSha: releaseCommit, deviceLabel: process.env.DEVICE_LABEL,
  });
} catch (error) { fail(error.message); }
fs.rmSync('published-release', { recursive: true, force: true });
execFileSync('gh', ['release', 'download', RELEASE_TAG, '-R', REPO,
  '-p', 'app-release.apk', '-p', 'app-release-androidTest.apk', '-D', 'published-release'], { stdio: 'inherit' });
if (sha256File('published-release/app-release.apk') !== metadata.apkSha256 ||
    sha256File('published-release/app-release-androidTest.apk') !== metadata.testApkSha256) {
  fail('published release assets do not match the Gate 6 production APK hashes');
}
fs.mkdirSync('evidence', { recursive: true });
fs.writeFileSync('evidence/production-smoke-input.json', JSON.stringify({
  candidateSha: CANDIDATE_SHA, gate6RunId: Number(GATE6_RUN_ID), releaseTag: RELEASE_TAG,
  productionProjectId: metadata.productionProjectId, activeKid: metadata.activeKid, packageLockSha256: metadata.packageLockSha256, assetLinksVerificationSha256: metadata.assetLinksVerificationSha256,
  apkSha256: metadata.apkSha256, testApkSha256: metadata.testApkSha256,
  signerSha256: metadata.signerSha256, productionRecoveryEnabled: false, device: qualification.device,
}, null, 2));
console.log('PASS: published APKs match the Gate 6 provenance-attested production build and exact candidate tag');
