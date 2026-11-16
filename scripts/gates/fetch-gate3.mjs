import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fail, requireSha, sha256File, verifyBundle } from './lib.mjs';

const { REPO, GATE3_RUN, CONTROL_BRANCH } = process.env;
const CANDIDATE_SHA = requireSha(process.env.CANDIDATE_SHA);
if (!REPO || !CONTROL_BRANCH) fail('Gate 3 run context is incomplete');
if (!/^[0-9]+$/.test(GATE3_RUN ?? '')) fail('bad run ID for Gate 3');
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
