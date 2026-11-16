import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATES = path.join(ROOT, 'scripts', 'gates');
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function tempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aurelia-gates-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function run(t, script, args = [], env = {}, cwd) {
  const result = spawnSync(process.execPath, [path.join(GATES, script), ...args], {
    cwd: cwd ?? tempDir(t),
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}
function output(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

test('instrumentation parser accepts the required passing test count', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'instrumentation.txt');
  fs.writeFileSync(file, [
    'INSTRUMENTATION_STATUS_CODE: 0',
    'INSTRUMENTATION_STATUS_CODE: 0',
    'INSTRUMENTATION_STATUS_CODE: 0',
    'INSTRUMENTATION_CODE: -1',
  ].join('\n'));
  const result = run(t, 'parse-instrument.mjs', [file, '3'], {}, dir);
  assert.equal(result.status, 0, output(result));
});

test('instrumentation parser rejects skips and insufficient test counts', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'instrumentation.txt');
  fs.writeFileSync(file, 'INSTRUMENTATION_STATUS_CODE: 0\nINSTRUMENTATION_STATUS_CODE: -2\nINSTRUMENTATION_CODE: -1\n');
  const skipped = run(t, 'parse-instrument.mjs', [file, '1'], {}, dir);
  assert.equal(skipped.status, 1);
  fs.writeFileSync(file, 'INSTRUMENTATION_STATUS_CODE: 0\nINSTRUMENTATION_CODE: -1\n');
  const insufficient = run(t, 'parse-instrument.mjs', [file, '2'], {}, dir);
  assert.equal(insufficient.status, 1);
});

test('log scanner writes metadata only and rejects credential-like lines', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'safe.log');
  fs.writeFileSync(file, 'normal startup complete\n');
  const safe = run(t, 'scan-logs.mjs', [file], {}, dir);
  assert.equal(safe.status, 0, output(safe));
  fs.writeFileSync(file, 'recoveryKey=supersecretvalue\n');
  const unsafe = run(t, 'scan-logs.mjs', [file], {}, dir);
  assert.equal(unsafe.status, 1);
  const report = fs.readFileSync(path.join(dir, 'evidence', 'log-scan.json'), 'utf8');
  assert.match(report, /credential-like assignment/);
  assert.doesNotMatch(report, /supersecretvalue/);
});

test('source flag scanner accepts OFF flags and enforced callable App Check', (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, 'functions', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.ts'), [
    'export const RECOVERY_ENABLED = false;',
    'export const LIVE_COLLECTION_ENABLED = false;',
    'export const AUTOMATIC_SETTLEMENT_ENABLED = false;',
    'export const AUTOMATIC_REFUNDS_ENABLED = false;',
    'export const CLOUD_SYNC_ENABLED = false;',
    'export const uiCutover = false;',
    'export const BT_PRINTING_ENABLED = false;',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'functions', 'src', 'index.ts'),
    'export const issueGrant = onCall({ enforceAppCheck: true }, async () => ({}));');
  const result = run(t, 'check-flags.mjs', [dir], {}, dir);
  assert.equal(result.status, 0, output(result));
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'evidence', 'flags.json'), 'utf8'));
  assert.equal(report.hits.length, 0);
  assert.equal(report.onCall, 1);
  assert.equal(report.enforced, 1);
});

test('source flag scanner rejects enabled production flags', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'config.ts'), 'export const RECOVERY_ENABLED = true;');
  const result = run(t, 'check-flags.mjs', [dir], {}, dir);
  assert.equal(result.status, 1);
  assert.match(output(result), /RECOVERY_ENABLED/);
});

test('staging probes reject non-HTTPS and non-staging hosts before network access', (t) => {
  const common = {
    STAGING_PROJECT_ID: 'aurelia-stage-12345',
    PRODUCTION_PROJECT_ID: 'aurelia-prod-12345',
    STAGING_REGION: 'asia-south1',
    RECOVERY_CALLABLES: 'issueRecoveryGrant',
  };
  const http = run(t, 'staging-probes.mjs', [], {
    ...common,
    STAGING_FUNCTIONS_BASE_URL: 'http://asia-south1-aurelia-stage-12345.cloudfunctions.net',
  });
  assert.equal(http.status, 1);
  assert.match(output(http), /HTTPS/);
  const wrongHost = run(t, 'staging-probes.mjs', [], {
    ...common,
    STAGING_FUNCTIONS_BASE_URL: 'https://asia-south1-aurelia-prod-12345.cloudfunctions.net',
  });
  assert.equal(wrongHost.status, 1);
  assert.match(output(wrongHost), /staging project/);
});

test('candidate SHA validation fails before any GitHub API call', (t) => {
  const result = run(t, 'check-candidate.mjs', ['--sha', 'not-a-sha', '--repo', 'owner/repo', '--branch', 'work/candidate']);
  assert.equal(result.status, 1);
  assert.match(output(result), /40 lowercase hex/);
});

test('required workflow verification rejects an unsafe candidate branch before API access', (t) => {
  const result = run(t, 'verify-runs.mjs', ['--sha', SHA_A, '--repo', 'owner/repo', '--group', 'gate1'], {
    CANDIDATE_BRANCH: '../untrusted',
  });
  assert.equal(result.status, 1);
  assert.match(output(result), /invalid candidate branch/);
});

test('evidence writer records candidate and control revisions only for PASS', (t) => {
  const dir = tempDir(t);
  const env = {
    GITHUB_SHA: SHA_B,
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_RUN_ID: '12345',
    GITHUB_RUN_ATTEMPT: '2',
  };
  const pass = run(t, 'write-evidence.mjs', ['--gate', '1', '--sha', SHA_A, '--status', 'PASS'], env, dir);
  assert.equal(pass.status, 0, output(pass));
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'evidence', 'record.json'), 'utf8'));
  assert.equal(record.candidateSha, SHA_A);
  assert.equal(record.controlSha, SHA_B);
  assert.equal(record.runId, 12345);
  assert.equal(record.runAttempt, 2);
  const fail = run(t, 'write-evidence.mjs', ['--gate', '1', '--sha', SHA_A, '--status', 'FAIL'], env, dir);
  assert.equal(fail.status, 1);
});

test('manual attestation rejects OTP material before any GitHub API call', (t) => {
  const result = run(t, 'validate-attestation.mjs', [
    '--kind', 'sms', '--sha', SHA_A, '--repo', 'owner/repo',
    '--gate3-run', '12345', '--control-branch', 'integration/ledger-patch',
  ], { ATTESTATION: JSON.stringify({ kind: 'sms', otp: '123456' }) });
  assert.equal(result.status, 1);
  assert.match(output(result), /6-digit sequence/);
});

test('qualification rejects malformed run ID JSON before GitHub API access', (t) => {
  const result = run(t, 'verify-qualification.mjs', [], {
    CANDIDATE_SHA: SHA_A,
    GITHUB_SHA: SHA_B,
    REPO: 'owner/repo',
    CONTROL_BRANCH: 'integration/ledger-patch',
    CANDIDATE_BRANCH: 'work/p0-storage-hardening',
    RUN_IDS: '{broken',
  });
  assert.equal(result.status, 1);
  assert.match(output(result), /RUN_IDS is not valid JSON/);
});

test('production audit fails closed when pointed at a non-production project', (t) => {
  const result = run(t, 'audit-production.mjs', [], {
    GCP_PROJECT_ID: 'aurelia-stage-12345',
    PRODUCTION_GCP_PROJECT_ID: 'aurelia-prod-12345',
    GCP_REGION: 'asia-south1',
  });
  assert.equal(result.status, 1);
  assert.match(output(result), /not the declared production project/);
});

test('Gate 3 fetch rejects a malformed run ID before GitHub API access', (t) => {
  const result = run(t, 'fetch-gate3.mjs', [], {
    REPO: 'owner/repo',
    GATE3_RUN: 'not-a-run-id',
    CONTROL_BRANCH: 'integration/ledger-patch',
    CANDIDATE_SHA: SHA_A,
  });
  assert.equal(result.status, 1);
  assert.match(output(result), /bad run ID/);
});
