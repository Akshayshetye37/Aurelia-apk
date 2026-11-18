import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fail, requireSha, sha256File, verifyBundle } from './lib.mjs';

const { REPO, CONTROL_BRANCH, CANDIDATE_BRANCH, CANDIDATE_SHA, GATE3_RUN_ID } = process.env;
const sha = requireSha(CANDIDATE_SHA);
if (!REPO || !CONTROL_BRANCH || !CANDIDATE_BRANCH || !/^\d+$/.test(GATE3_RUN_ID ?? '')) {
  fail('Gate 3 build-lock input context is incomplete');
}
const record = verifyBundle({
  repo: REPO, runId: GATE3_RUN_ID, gate: '3',
  workflowFile: 'gate-3-real-sms-staging.yml',
  controlBranch: CONTROL_BRANCH, dir: 'gate3-lock-evidence',
});
if (record.candidateSha !== sha) fail('Gate 3 lock artifact belongs to a different candidate');
if (!/^[0-9a-f]{64}$/.test(record.details.packageLockSha256 ?? '')) fail('Gate 3 evidence lacks the resolved package-lock hash');
const artifactDir = 'gate3-build-input';
fs.rmSync(artifactDir, { recursive: true, force: true });
execFileSync('gh', ['run', 'download', String(GATE3_RUN_ID), '-R', REPO,
  '-n', `aurelia-recovery-staging-apk-${sha}`, '-D', artifactDir], { stdio: 'inherit' });
const lockPath = path.join(artifactDir, 'package-lock.json');
if (!fs.existsSync(lockPath) || !fs.statSync(lockPath).isFile()) fail('Gate 3 resolved package-lock artifact is missing');
const actualHash = sha256File(lockPath);
if (actualHash !== record.details.packageLockSha256) fail('Gate 3 package-lock bytes do not match provenance-attested evidence');
const candidateLock = path.join('candidate', 'package-lock.json');
if (!fs.existsSync('candidate/package.json')) fail('candidate package.json is missing');
fs.copyFileSync(lockPath, candidateLock);
if (sha256File(candidateLock) !== actualHash) fail('candidate package-lock copy hash mismatch');
console.log(`PASS: exact Gate 3 dependency lock ${actualHash} copied to production candidate build`);
