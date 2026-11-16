import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fail, requireSha, sha256File, verifyBundle } from './lib.mjs';

const { REPO, GATE3_RUN, CONTROL_BRANCH, CANDIDATE_SHA } = process.env;
if (!REPO || !CONTROL_BRANCH || !/^\d+$/.test(GATE3_RUN ?? '')) fail('Gate 3 run context is incomplete');
const record = verifyBundle({
  repo: REPO, runId: GATE3_RUN, gate: '3',
  workflowFile: 'gate-3-real-sms-staging.yml',
  controlBranch: CONTROL_BRANCH, dir: 'g3',
});
if (record.candidateSha !== CANDIDATE_SHA) fail('Gate 3 is for a different candidate');
execFileSync('gh', ['run', 'download', String(GATE3_RUN), '-R', REPO, '-n', 'gate-3-apks', '-D', 'apks'], { stdio: 'inherit' });
if (sha256File('apks/app.apk') !== record.details.apkSha256) fail('app APK hash mismatch');
if (sha256File('apks/test.apk') !== record.details.testApkSha256) fail('test APK hash mismatch');
fs.writeFileSync('g3/verified.txt', 'ok\n');
console.log('Gate 3 APKs match their provenance-attested hashes');
