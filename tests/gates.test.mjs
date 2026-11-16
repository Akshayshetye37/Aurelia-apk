import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  fs.writeFileSync(file, 'recoveryKey=supersecretvalue\nOTP is 123456\nGuest phone 9876543210\n');
  const unsafe = run(t, 'scan-logs.mjs', [file], {}, dir);
  assert.equal(unsafe.status, 1);
  const report = fs.readFileSync(path.join(dir, 'evidence', 'log-scan.json'), 'utf8');
  assert.match(report, /credential-like assignment/);
  assert.match(report, /OTP value in message context/);
  assert.match(report, /full phone number/);
  assert.doesNotMatch(report, /supersecretvalue|123456|9876543210/);
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

function runVerifyBundle(t, certificate, { event = 'workflow_dispatch', gate = '1', workflowFile = 'gate-1-encrypted-storage.yml' } = {}) {
  const dir = tempDir(t);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const fakeGh = path.join(bin, 'gh');
  const fakeSource = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'api') {
  if (args[1] === 'repos/owner/repo') console.log(JSON.stringify({ id: 999 }));
  else if (args[1] === 'repos/owner/repo/actions/runs/123') console.log(JSON.stringify({
    status: 'completed', conclusion: 'success', head_branch: 'integration/ledger-patch',
    path: '.github/workflows/' + process.env.FAKE_WORKFLOW_FILE + '@refs/heads/integration/ledger-patch',
    event: process.env.FAKE_EVENT, head_sha: process.env.FAKE_CONTROL_SHA, run_attempt: 1
  }));
  else process.exit(2);
} else if (args[0] === 'run' && args[1] === 'download') {
  const destination = args[args.indexOf('-D') + 1];
  fs.mkdirSync(path.join(destination, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(destination, 'evidence', 'record.json'), process.env.FAKE_RECORD);
  execFileSync('tar', ['-cf', 'bundle.tar', 'evidence'], { cwd: destination });
} else if (args[0] === 'attestation' && args[1] === 'verify') {
  console.log(JSON.stringify([{ verificationResult: { signature: { certificate: JSON.parse(process.env.FAKE_CERT) } } }]));
} else {
  console.error('unexpected fake gh command');
  process.exit(2);
}
`;
  fs.writeFileSync(fakeGh, fakeSource);
  fs.chmodSync(fakeGh, 0o755);
  const controlSha = SHA_B;
  const record = {
    gate, status: 'PASS', runId: 123, runAttempt: 1,
    repository: 'owner/repo', candidateSha: SHA_A, controlSha,
  };
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FAKE_CONTROL_SHA: controlSha,
    FAKE_RECORD: JSON.stringify(record),
    FAKE_CERT: JSON.stringify(certificate),
    FAKE_EVENT: event,
    FAKE_GATE: gate,
    FAKE_WORKFLOW_FILE: workflowFile,
  };
  const libUrl = pathToFileURL(path.join(GATES, 'lib.mjs')).href;
  const code = `import { verifyBundle } from ${JSON.stringify(libUrl)}; verifyBundle({
    repo: 'owner/repo', runId: '123', gate: ${JSON.stringify(gate)},
    workflowFile: ${JSON.stringify(workflowFile)},
    controlBranch: 'integration/ledger-patch', dir: 'bundle-out'
  });`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: dir, env, encoding: 'utf8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
  });
}
function validCertificate({ trigger = 'workflow_dispatch', workflowFile = 'gate-1-encrypted-storage.yml' } = {}) {
  return {
    issuer: 'https://token.actions.githubusercontent.com',
    sourceRepositoryURI: 'https://github.com/owner/repo',
    sourceRepositoryIdentifier: '999',
    sourceRepositoryDigest: SHA_B,
    sourceRepositoryRef: 'refs/heads/integration/ledger-patch',
    buildSignerURI: `https://github.com/owner/repo/.github/workflows/${workflowFile}@refs/heads/integration/ledger-patch`,
    buildSignerDigest: SHA_B,
    runInvocationURI: 'https://github.com/owner/repo/actions/runs/123/attempts/1',
    runnerEnvironment: 'github-hosted',
    buildTrigger: trigger,
  };
}

test('bundle verification binds the trusted certificate to repository, workflow, commit and exact run attempt', (t) => {
  const result = runVerifyBundle(t, validCertificate());
  assert.equal(result.status, 0, output(result));
});

test('bundle verification rejects a certificate from a different run or self-hosted runner', (t) => {
  const wrongRun = validCertificate();
  wrongRun.runInvocationURI = 'https://github.com/owner/repo/actions/runs/124/attempts/1';
  const runMismatch = runVerifyBundle(t, wrongRun);
  assert.equal(runMismatch.status, 1);
  assert.match(output(runMismatch), /not bound to run 123/);
  const selfHosted = validCertificate();
  selfHosted.runnerEnvironment = 'self-hosted';
  const runnerMismatch = runVerifyBundle(t, selfHosted);
  assert.equal(runnerMismatch.status, 1);
  assert.match(output(runnerMismatch), /not bound to run 123/);
});

test('bundle verification accepts trusted push evidence only for Gates 1 and 2', (t) => {
  const gate1 = runVerifyBundle(t, validCertificate({ trigger: 'push' }), { event: 'push', gate: '1' });
  assert.equal(gate1.status, 0, output(gate1));
  const gate3 = runVerifyBundle(t, validCertificate({ trigger: 'push', workflowFile: 'gate-3-real-sms-staging.yml' }), {
    event: 'push', gate: '3', workflowFile: 'gate-3-real-sms-staging.yml',
  });
  assert.equal(gate3.status, 1);
  assert.match(output(gate3), /unsupported trigger push/);
});

test('required workflow verifier does not ignore a newer in-progress rerun', (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, 'gates'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'gates', 'required-runs.json'), path.join(dir, 'gates', 'required-runs.json'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const fakeGh = path.join(bin, 'gh');
  fs.writeFileSync(fakeGh, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'api') {
  console.log(JSON.stringify({ workflow_runs: [{
    id: 456, run_number: 12, run_attempt: 1,
    head_sha: '${SHA_A}', head_branch: 'work/p0-storage-hardening',
    status: 'in_progress', conclusion: null,
    html_url: 'https://github.com/owner/repo/actions/runs/456',
    updated_at: '2026-11-16T08:00:00Z'
  }] }));
} else { console.error('unexpected gh command'); process.exit(2); }
`);
  fs.chmodSync(fakeGh, 0o755);
  const result = spawnSync(process.execPath, [
    path.join(GATES, 'verify-runs.mjs'), '--sha', SHA_A, '--repo', 'owner/repo', '--group', 'gate1',
  ], {
    cwd: dir,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CANDIDATE_BRANCH: 'work/p0-storage-hardening' },
    encoding: 'utf8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.status, 1);
  assert.match(output(result), /latest run .* is in_progress\/pending/);
});

test('manual attestation rejects a tester who appears in the approval list', () => {
  const libUrl = pathToFileURL(path.join(GATES, 'lib.mjs')).href;
  const code = `import { requireIndependentTester } from ${JSON.stringify(libUrl)}; requireIndependentTester(['tester-one'], 'Tester-One');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.status, 1);
  assert.match(output(result), /tester cannot approve their own/);
});

test('manual attestation accepts a tester distinct from every approver', () => {
  const libUrl = pathToFileURL(path.join(GATES, 'lib.mjs')).href;
  const code = `import { requireIndependentTester } from ${JSON.stringify(libUrl)}; requireIndependentTester(['release-reviewer'], 'field-tester');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.status, 0, output(result));
});
