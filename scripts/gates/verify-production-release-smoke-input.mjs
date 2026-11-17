import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fail, sha256File, verifyBundle } from './lib.mjs';

const { REPO, CONTROL_BRANCH, CANDIDATE_BRANCH, CANDIDATE_SHA, GATE6_RUN_ID, RELEASE_TAG } = process.env;
if (!REPO || !CONTROL_BRANCH || !CANDIDATE_BRANCH) fail('release smoke context is incomplete');
if (!/^[0-9a-f]{40}$/.test(CANDIDATE_SHA ?? '')) fail('candidate SHA is invalid');
if (!/^[1-9][0-9]{0,15}$/.test(GATE6_RUN_ID ?? '')) fail('Gate 6 run ID is invalid');
if (!/^[A-Za-z0-9._-]{1,128}$/.test(RELEASE_TAG ?? '')) fail('release tag is invalid');

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
if (qualification.status !== 'QUALIFIED_FOR_RELEASE_REVIEW' ||
    qualification.candidateSha !== CANDIDATE_SHA || qualification.productionRecoveryEnabled !== false) {
  fail('Gate 6 result is not qualified or does not prove production recovery OFF');
}
if (!qualification.productionRelease || qualification.productionRelease.apkSha256 !== attestedRelease.apkSha256 ||
    qualification.productionRelease.testApkSha256 !== attestedRelease.testApkSha256 ||
    qualification.productionRelease.signerSha256 !== attestedRelease.signerSha256 ||
    qualification.productionRelease.activeKid !== attestedRelease.activeKid ||
    qualification.productionRelease.productionProjectId !== attestedRelease.productionProjectId) {
  fail('Gate 6 production release metadata does not match its attested release record');
}

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
if (metadata.candidateSha !== CANDIDATE_SHA || metadata.candidateBranch !== CANDIDATE_BRANCH ||
    metadata.productionProjectId !== attestedRelease.productionProjectId ||
    metadata.activeKid !== attestedRelease.activeKid ||
    metadata.apkSha256 !== attestedRelease.apkSha256 ||
    metadata.testApkSha256 !== attestedRelease.testApkSha256 ||
    metadata.signerSha256 !== attestedRelease.signerSha256) {
  fail('downloaded Gate 6 production artifact differs from the provenance-attested metadata');
}

const releaseCommit = JSON.parse(execFileSync('gh', ['api', `repos/${REPO}/commits/${encodeURIComponent(RELEASE_TAG)}`], { encoding: 'utf8' })).sha;
if (releaseCommit !== CANDIDATE_SHA) fail('published release tag does not point to the exact qualified candidate SHA');
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
  productionProjectId: metadata.productionProjectId, activeKid: metadata.activeKid,
  apkSha256: metadata.apkSha256, testApkSha256: metadata.testApkSha256,
  signerSha256: metadata.signerSha256, productionRecoveryEnabled: false,
}, null, 2));
console.log('PASS: published APKs match the Gate 6 provenance-attested production build and exact candidate tag');
