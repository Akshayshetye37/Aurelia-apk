import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateSmsAttestation, containsPhoneNumberLikeValue } from '../scripts/gates/attestation-schema.mjs';
import { isAttestationFresh, validateEnvironmentApprovals, requireNamedEnvironmentApprover } from '../scripts/gates/lib.mjs';
import { validateFirebaseFingerprintInventory, countTestPhoneNumbers, firebaseAndroidShaEndpoint, isProductionAuditEvidenceValid, hasPublicRuntimeInvoker, hasExactServiceInvoker, findProjectWideRecoveryRisks, findMissingGen2FunctionServices, validateFunctionSecretAccess, validateSecretPolicy, findPrivilegedProjectRoles } from '../scripts/gates/firebase-audit-schema.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATES = path.join(ROOT, 'scripts', 'gates');
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

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

function runQualificationOfflineValidation(t, runIds) {
  const dir = tempDir(t);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const marker = path.join(dir, 'gh-called');
  const fakeGh = path.join(bin, 'gh');
  fs.writeFileSync(fakeGh, [
    '#!/usr/bin/env node',
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "called");`,
    'process.exit(2);',
  ].join('\n'));
  fs.chmodSync(fakeGh, 0o755);
  const result = run(t, 'verify-qualification.mjs', [], {
    CANDIDATE_SHA: SHA_A,
    GITHUB_SHA: SHA_B,
    REPO: 'owner/repo',
    CONTROL_BRANCH: 'integration/ledger-patch',
    CANDIDATE_BRANCH: 'work/p0-storage-hardening',
    RUN_IDS: JSON.stringify(runIds),
    PATH: bin + path.delimiter + process.env.PATH,
  }, dir);
  return { result, marker };
}

function runManualAttestationOffline(t, actor, attestation) {
  const dir = tempDir(t);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const marker = path.join(dir, 'gh-called');
  const fakeGh = path.join(bin, 'gh');
  fs.writeFileSync(fakeGh, [
    '#!/usr/bin/env node',
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "called");`,
    'process.exit(2);',
  ].join('\n'));
  fs.chmodSync(fakeGh, 0o755);
  const result = run(t, 'validate-attestation.mjs', [
    '--kind', 'sms', '--sha', SHA_A, '--repo', 'owner/repo',
    '--gate3-run', '12345', '--control-branch', 'integration/ledger-patch',
  ], {
    ATTESTATION: JSON.stringify(attestation),
    ACTOR: actor ?? '',
    PATH: bin + path.delimiter + process.env.PATH,
  }, dir);
  return { result, marker };
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
    RECOVERY_CALLABLES: 'createRecoveryAttestationChallenge,verifyRecoveryDeviceAttestation,registerRecoveryPhone,exchangeOwnerEmailLink,confirmRecoveryOwnerBinding,registerRecoveryOwnerDevice,createRecoveryPasskeyEnrollmentOptions,completeRecoveryPasskeyEnrollment,retryRecoveryPasskeyEnrollmentAlert,getRecoveryOwnerPendingAction,getRecoveryOwnerActionReadiness,createRecoveryOwnerActionOptions,completeRecoveryOwnerPasskeyAction,acknowledgeRecoveryOwnerAlert,issueRecoveryGrant,consumeRecoveryGrant,cancelRecoveryRequest,cancelRecoveryPhoneChange,activateRecoveryPhoneChange',
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

test('manual attestation rejects the triggering actor as tester before GitHub API access', (t) => {
  const attestation = {
    kind: 'sms',
    apkSha256: 'a'.repeat(64),
    testedAt: new Date().toISOString(),
    tester: 'Alice-QA',
    results: {},
  };
  const { result, marker } = runManualAttestationOffline(t, 'alice-qa', attestation);
  assert.equal(result.status, 1);
  assert.match(output(result), /cannot be the person who triggered/);
  assert.equal(fs.existsSync(marker), false, 'GitHub CLI must not be invoked for self-attestation');
});

test('manual attestation requires a triggering actor before GitHub API access', (t) => {
  const attestation = {
    kind: 'sms',
    apkSha256: 'a'.repeat(64),
    testedAt: new Date().toISOString(),
    tester: 'Alice-QA',
    results: {},
  };
  const { result, marker } = runManualAttestationOffline(t, undefined, attestation);
  assert.equal(result.status, 1);
  assert.match(output(result), /triggering actor is unavailable/);
  assert.equal(fs.existsSync(marker), false, 'GitHub CLI must not be invoked without an actor');
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

test('qualification rejects missing RUN_IDS keys before any GitHub API call', (t) => {
  const { result, marker } = runQualificationOfflineValidation(t, { '1': '101' });
  assert.equal(result.status, 1);
  assert.match(output(result), /RUN_IDS must contain exactly/);
  assert.equal(fs.existsSync(marker), false, 'GitHub CLI must not be invoked for malformed RUN_IDS');
});

test('qualification rejects non-numeric RUN_IDS before any GitHub API call', (t) => {
  const { result, marker } = runQualificationOfflineValidation(t, {
    '1': '101', '2': '102', '3': '103', '4': '104', '5': '105', sms: '106', device: 'not-a-run-id',
  });
  assert.equal(result.status, 1);
  assert.match(output(result), /invalid run ID for device/);
  assert.equal(fs.existsSync(marker), false, 'GitHub CLI must not be invoked for non-numeric run IDs');
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
    status: 'completed', conclusion: 'success', completed_at: new Date().toISOString(), head_branch: 'integration/ledger-patch',
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

test('release approvals must come from both named protected environments and distinct reviewers', () => {
  const history = [
    { state: 'approved', user: { login: 'reviewer-one' }, environments: [{ name: 'recovery-release-review-1' }] },
    { state: 'approved', user: { login: 'reviewer-two' }, environments: [{ name: 'recovery-release-review-2' }] },
  ];
  assert.deepEqual(
    validateEnvironmentApprovals(history, ['recovery-release-review-1', 'recovery-release-review-2'], 2, 'release-trigger'),
    ['reviewer-one', 'reviewer-two'],
  );
  assert.throws(
    () => validateEnvironmentApprovals([history[0], { ...history[1], user: { login: 'reviewer-one' } }],
      ['recovery-release-review-1', 'recovery-release-review-2'], 2, 'release-trigger'),
    /need 2 independent approver/,
  );
  assert.throws(
    () => validateEnvironmentApprovals([history[0]], ['recovery-release-review-1', 'recovery-release-review-2'], 1, 'release-trigger'),
    /recovery-release-review-2 has no approved reviewer/,
  );
  assert.throws(
    () => validateEnvironmentApprovals([{ ...history[0], user: { login: 'release-trigger' } }],
      ['recovery-release-review-1'], 1, 'release-trigger'),
    /cannot approve it/,
  );
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


test('Gate 3 SMS attestation requires real delivery timestamp, challenge ID and redacted device identity', () => {
 const now=Date.parse('2026-11-16T12:00:00.000Z'), valid={testedAt:'2026-11-16T11:59:00.000Z',smsDeliveredAt:'2026-11-16T11:55:00.000Z',challengeId:'123e4567-e89b-42d3-a456-426614174000',deviceLabel:'Pixel 8 Android 15',deviceIdentitySha256:'a'.repeat(64)};
 assert.equal(validateSmsAttestation(valid,now),true);
 for(const field of ['smsDeliveredAt','challengeId','deviceLabel','deviceIdentitySha256']) { const bad={...valid}; delete bad[field]; assert.throws(()=>validateSmsAttestation(bad,now)); }
 assert.throws(()=>validateSmsAttestation({...valid,smsDeliveredAt:'2026-11-16T11:00:00.000Z'},now),/within 15 minutes/);
 assert.throws(()=>validateSmsAttestation({...valid,testedAt:'2026-11-16T11:59:00'},now),/RFC 3339/);
 assert.throws(()=>validateSmsAttestation({...valid,deviceLabel:'serial=ABC123'},now),/redacted/);
});
test('Gate 5 Firebase audit requires exact app and SHA-1/SHA-256 inventories and zero test numbers', () => {
 const apps=[{appId:'app-one',packageName:'com.aurelia.pms',state:'ACTIVE'}], certs={'app-one':[{certType:'SHA_1',shaHash:'1'.repeat(40)},{certType:'SHA_256',shaHash:'a'.repeat(64)}]};
 assert.deepEqual(validateFirebaseFingerprintInventory(apps,certs,['app-one'],['1'.repeat(40)],['a'.repeat(64)]),{androidApps:1,sha1Fingerprints:1,sha256Fingerprints:1,sha256CertificateHashes:['a'.repeat(64)]});
 assert.throws(()=>validateFirebaseFingerprintInventory(apps,certs,['app-one','app-two'],['1'.repeat(40)],['a'.repeat(64)]),/exactly match/);
 assert.throws(()=>validateFirebaseFingerprintInventory(apps,certs,['app-one'],['1'.repeat(40)],['b'.repeat(64)]),/SHA-256 inventory/);
 assert.equal(countTestPhoneNumbers({signIn:{phoneNumber:{testPhoneNumbers:{'+10000000000':'redacted'}}}}),1);
});


test('phone-number scan ignores numeric runs inside SHA-256 digests but rejects phone-like values elsewhere', () => {
  const digest = '1234567890' + 'a'.repeat(54);
  assert.equal(containsPhoneNumberLikeValue({ deviceIdentitySha256: digest }), false);
  assert.equal(containsPhoneNumberLikeValue({ apkSha256: digest }), false);
  assert.equal(containsPhoneNumberLikeValue({ tester: '9876543210' }), true);
  assert.equal(containsPhoneNumberLikeValue({ results: { note: 'contact 9876543210' } }), true);
});

test('Gate 5 requests signing fingerprints from the documented project-scoped Firebase API resource', () => {
  assert.equal(
    firebaseAndroidShaEndpoint('aurelia-prod-12345', '1:123456789:android:abcdef012345'),
    'https://firebase.googleapis.com/v1beta1/projects/aurelia-prod-12345/androidApps/1%3A123456789%3Aandroid%3Aabcdef012345/sha',
  );
  assert.throws(() => firebaseAndroidShaEndpoint('aurelia-prod-12345', 'not-an-app-id'), /app ID is invalid/);
  assert.throws(() => firebaseAndroidShaEndpoint('-', '1:123456789:android:abcdef012345'), /project ID is invalid/);
});

test('Gate 6 requires Gate 3 release signer to be in the attested production Firebase SHA-256 inventory', () => {
  const signer = 'a'.repeat(64);
  const audit = {
    project: 'aurelia-prod-12345',
    problems: [],
    auditedResources: { functions: 5, gen1Functions: 5, gen2Functions: 0, functionIamPolicies: 5, runServices: 1, runIamPolicies: 1 },
    firebaseAudit: {
      androidApps: 1,
      sha1Fingerprints: 1,
      sha256Fingerprints: 1,
      sha256CertificateHashes: [signer],
      projectTestPhoneNumbers: 0,
      tenantTestPhoneNumbers: 0,
      tenants: 0,
    },
  };
  assert.equal(isProductionAuditEvidenceValid(audit, audit.project, signer), true);
  assert.equal(isProductionAuditEvidenceValid(audit, audit.project, 'b'.repeat(64)), false);
  assert.equal(isProductionAuditEvidenceValid({ ...audit, firebaseAudit: { ...audit.firebaseAudit, projectTestPhoneNumbers: 1 } }, audit.project, signer), false);
  assert.equal(isProductionAuditEvidenceValid({ ...audit, problems: ['App Check not enforced'] }, audit.project, signer), false);
  assert.equal(isProductionAuditEvidenceValid({ ...audit, auditedResources: { functions: 5, gen1Functions: 5, gen2Functions: 0, functionIamPolicies: 5, runServices: 0, runIamPolicies: 0 } }, audit.project, signer), false);
  assert.equal(isProductionAuditEvidenceValid({ ...audit, auditedResources: { ...audit.auditedResources, functionIamPolicies: 4 } }, audit.project, signer), false);
  assert.equal(isProductionAuditEvidenceValid({ ...audit, auditedResources: { ...audit.auditedResources, gen1Functions: 4 } }, audit.project, signer), false);
  assert.equal(isProductionAuditEvidenceValid({ ...audit, auditedResources: { ...audit.auditedResources, gen2Functions: 1 } }, audit.project, signer), false);
  assert.equal(isProductionAuditEvidenceValid({ ...audit, auditedResources: { ...audit.auditedResources, runIamPolicies: 0 } }, audit.project, signer), false);
});

test('Gates 3–6 are dispatch-only, candidate-pinned and use protected execution boundaries', () => {
  const gate3 = read('.github/workflows/gate-3-real-sms-staging.yml');
  const gate4 = read('.github/workflows/gate-4-physical-device.yml');
  const gate5 = read('.github/workflows/gate-5-production-security.yml');


  const gate6 = read('.github/workflows/gate-6-release-signoff.yml');
  for (const workflow of [gate3, gate4, gate5, gate6]) {
    assert.match(workflow, /workflow_dispatch:/);
    assert.match(workflow, /candidate_sha:/);
    assert.match(workflow, /integration\/ledger-patch/);
    assert.match(workflow, /check-candidate\.mjs/);
  }
  assert.match(gate3, /uses: \.\/\.github\/workflows\/recovery-staging-deploy\.yml/);
  assert.match(gate3, /actions\/attest-build-provenance/);
  assert.match(gate4, /runs-on: \[self-hosted, linux, x64, aurelia-android-device\]/);
  assert.match(gate4, /environment: recovery-device/);
  assert.match(gate4.slice(gate4.indexOf('  attest:')), /runs-on: ubuntu-latest/);
  assert.match(gate5, /environment: recovery-production-audit/);
  assert.match(gate5, /audit-production\.mjs/);
  assert.match(gate6, /needs: preflight/);
  assert.match(gate6, /environment: recovery-release-review-1/);
  assert.match(gate6, /environment: recovery-release-review-2/);
  assert.match(gate6, /verify-qualification\.mjs/);
  const manual = read('.github/workflows/gate-manual-attestation.yml');
  assert.match(manual, /environment: recovery-attestation/);
  assert.match(manual, /validate-attestation\.mjs/);
});

test('Gate 6 requires a distinct owner sign-off plus two independent release reviewers', () => {
  const gate6 = read('.github/workflows/gate-6-release-signoff.yml');
  const verifier = read('scripts/gates/verify-qualification.mjs');
  for (const environment of ['recovery-release-owner', 'recovery-release-review-1', 'recovery-release-review-2']) {
    assert.ok(gate6.includes(`environment: ${environment}`));
    assert.ok(verifier.includes(environment));
  }
  assert.ok(verifier.includes('requireApprovals(repo, process.env.GITHUB_RUN_ID, 3'));
  assert.ok(gate6.includes('needs: [preflight, owner-signoff, independent-reviewer-one, independent-reviewer-two]'));
  const ownerStart = gate6.indexOf('  owner-signoff:');
  const reviewerStart = gate6.indexOf('  independent-reviewer-one:', ownerStart);
  const ownerJob = gate6.slice(ownerStart, reviewerStart);
  const permissionsStart = ownerJob.indexOf('    permissions:');
  const envStart = ownerJob.indexOf('    env:', permissionsStart);
  const ownerPermissions = ownerJob.slice(permissionsStart, envStart).split('\n').map(line => line.trim());
  assert.ok(ownerPermissions.includes('id-token: write'),
    'Gate 6 owner job must request the GitHub OIDC token used by production WIF authentication');
});

test('Gate 6 production build reuses Gate 3 dependencies and verifies the production signer', () => {
  const staging = read('.github/workflows/recovery-staging-deploy.yml');
  const gate3 = read('.github/workflows/gate-3-real-sms-staging.yml');
  const gate6 = read('.github/workflows/gate-6-release-signoff.yml');
  const verifier = read('scripts/gates/verify-qualification.mjs');
  const audit = read('scripts/gates/audit-production.mjs');
  assert.match(staging, /package-lock\.json/);
  assert.match(gate3, /packageLockSha256/);
  assert.match(gate6, /fetch-gate3-build-lock\.mjs/);
  assert.match(gate6, /npm ci --no-audit --no-fund/);
  assert.match(gate6, /PRODUCTION_GOOGLE_SERVICES_JSON_BASE64/);
  assert.match(gate6, /PRODUCTION_KEYSTORE_BASE64/);
  assert.match(gate6, /gate-6-production-release/);
  assert.match(verifier, /productionRelease\.packageLockSha256 !== records\['3'\]\.details\.packageLockSha256/);
  assert.match(audit, /validateProductionSigningKeyId/);
  assert.match(gate6, /verify-production-signing-key\.mjs/);
  assert.match(audit, /validateProductionKeyVerifierWif/);
  assert.match(audit, /production signing-key verifier must not access PHONE_PEPPER/);
});

test('staging and production only enable passkey readiness after Google Digital Asset Links verification', () => {
  const staging = read('.github/workflows/recovery-staging-deploy.yml');
  const gate3 = read('.github/workflows/gate-3-real-sms-staging.yml');
  const gate6 = read('.github/workflows/gate-6-release-signoff.yml');
  const smoke = read('.github/workflows/production-release-smoke.yml');
  const verifier = read('scripts/gates/verify-assetlinks.mjs');
  const apiVerifier = read('scripts/gates/assetlinks-verification.mjs');
  const schema = read('scripts/gates/assetlinks-evidence-schema.mjs');
  assert.match(staging, /verify-assetlinks\.mjs/);
  assert.match(staging, /WEBAUTHN_ASSETLINKS_VERIFIED=true/);
  assert.match(staging, /WEBAUTHN_ANDROID_ORIGINS/);
  assert.match(gate3, /assetLinksVerificationSha256/);
  assert.match(gate3, /aurelia-recovery-assetlinks-/);
  assert.match(gate6, /REQUIRED_CERT_SHA256/);
  assert.match(gate6, /assetLinksVerificationSha256/);
  assert.match(smoke, /verify-assetlinks\.mjs/);
  assert.match(verifier, /verifyAssetLinks/);
  assert.match(apiVerifier, /digitalassetlinks\.googleapis\.com/);
  assert.match(schema, /validateAssetLinksEvidence/);
});

test('post-release smoke re-audits production and verifies the published APK on the approved handset', () => {
  const workflow = read('.github/workflows/production-release-smoke.yml');
  const verifier = read('scripts/gates/verify-production-release-smoke-input.mjs');
  assert.match(workflow, /environment: recovery-production-audit/);
  assert.match(workflow, /environment: recovery-device/);
  assert.match(workflow, /production-release-smoke-input\.mjs/);
  assert.match(workflow, /OtpRecoverySqlCipherInstrumentedTest/);
  assert.match(workflow, /scan-logs\.mjs/);
  assert.match(verifier, /gh.*release/);
  assert.match(verifier, /productionRecoveryEnabled/);
});

test('device attestation requires all manual recovery-denial cases and binds one handset', () => {
  const schema = read('scripts/gates/device-attestation-schema.mjs');
  const preflight = read('scripts/gates/preflight.mjs');
  assert.match(schema, /notificationPermissionOffBlocksRecovery/);
  assert.match(schema, /ownerDeviceOfflineBlocksRecovery/);
  assert.match(schema, /noIndependentOwnerDeviceBlocksRecovery/);
  assert.match(schema, /simSwapRejected/);
  assert.match(schema, /hardwareBackedAttestationVerified/);
  assert.match(schema, /passkeyAssertionVerified/);
  assert.match(preflight, /GCP_AUDIT_SERVICE_ACCOUNT/);
  assert.match(preflight, /PHONE_PEPPER/);
  assert.match(preflight, /PRODUCTION_KEYSTORE_BASE64/);
});

test('Gate 6 requires the configured owner login to approve the owner environment', () => {
  const history = [
    { state: 'approved', user: { login: 'owner-one' }, environments: [{ name: 'recovery-release-owner' }] },
    { state: 'approved', user: { login: 'reviewer-one' }, environments: [{ name: 'recovery-release-review-1' }] },
  ];
  assert.equal(requireNamedEnvironmentApprover(history, 'recovery-release-owner', 'Owner-One'), true);
  assert.throws(() => requireNamedEnvironmentApprover(history, 'recovery-release-owner', 'different-owner'), /did not approve environment/);
  assert.throws(() => requireNamedEnvironmentApprover(history, 'recovery-release-review-1', 'owner-one'), /did not approve environment/);
});

test('Gate 6 requires one owner and two distinct protected-environment reviewers', () => {
  const environments = ['recovery-release-owner', 'recovery-release-review-1', 'recovery-release-review-2'];
  const history = [
    { state: 'approved', user: { login: 'candidate-owner' }, environments: [{ name: environments[0] }] },
    { state: 'approved', user: { login: 'reviewer-one' }, environments: [{ name: environments[1] }] },
    { state: 'approved', user: { login: 'reviewer-two' }, environments: [{ name: environments[2] }] },
  ];
  assert.deepEqual(
    validateEnvironmentApprovals(history, environments, 3, 'workflow-actor').sort(),
    ['candidate-owner', 'reviewer-one', 'reviewer-two'],
  );
  assert.throws(() => validateEnvironmentApprovals(history.slice(1), environments, 3, 'workflow-actor'), /recovery-release-owner/);
  const duplicate = [history[0], history[1], { ...history[2], user: { login: 'reviewer-one' } }];
  assert.throws(() => validateEnvironmentApprovals(duplicate, environments, 3, 'workflow-actor'), /need 3 independent approver/);
  assert.throws(() => validateEnvironmentApprovals(history, environments, 3, 'candidate-owner'), /cannot approve it/);
});


test('Gate 3 staging configuration preflight is valid Bash and validates WebAuthn RP identifiers', () => {
  const workflow = read('.github/workflows/recovery-staging-deploy.yml');
  const newline = String.fromCharCode(10);
  const step = '      - name: Validate staging configuration without printing secrets';
  const stepStart = workflow.indexOf(step);
  assert.notEqual(stepStart, -1, 'staging configuration preflight must exist');
  const runStart = workflow.indexOf('        run: |', stepStart);
  assert.notEqual(runStart, -1, 'staging preflight must use a block shell script');
  const nextStep = workflow.indexOf(newline + '      - name:', runStart);
  assert.notEqual(nextStep, -1, 'staging preflight must terminate before the next step');
  const script = workflow.slice(runStart + '        run: |'.length, nextStep)
    .split(newline)
    .map((line) => line.startsWith('          ') ? line.slice(10) : line)
    .join(newline);
  const parsed = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr || 'Gate 3 staging preflight contains invalid Bash');
  assert.ok(script.includes("rp_name_re='^[A-Za-z0-9._ -]{1,64}$'"));
  assert.ok(script.includes('WEBAUTHN_RP_NAME') && script.includes('rp_name_re'));
  assert.ok(script.includes('WEBAUTHN_RP_ID') && script.includes('rp_id_re'));
});

test('Gate 3 and Gate 6 pin App Check probes to the deployed recovery callable inventory', () => {
  const probeScript = read('scripts/gates/staging-probes.mjs');
  const verifier = read('scripts/gates/verify-qualification.mjs');
  for (const name of [
    'createRecoveryAttestationChallenge',
    'verifyRecoveryDeviceAttestation',
    'registerRecoveryPhone',
    'exchangeOwnerEmailLink',
    'confirmRecoveryOwnerBinding',
    'registerRecoveryOwnerDevice',
    'createRecoveryPasskeyEnrollmentOptions',
    'completeRecoveryPasskeyEnrollment',
    'retryRecoveryPasskeyEnrollmentAlert',
    'getRecoveryOwnerPendingAction',
    'getRecoveryOwnerActionReadiness',
    'createRecoveryOwnerActionOptions',
    'completeRecoveryOwnerPasskeyAction',
    'acknowledgeRecoveryOwnerAlert',
    'issueRecoveryGrant',
    'consumeRecoveryGrant',
    'cancelRecoveryRequest',
    'cancelRecoveryPhoneChange',
    'activateRecoveryPhoneChange'
  ]) {
    assert.ok(probeScript.includes(name), `staging probes must include ${name}`);
    assert.ok(verifier.includes(name), `Gate 6 must require ${name}`);
  }
  assert.match(probeScript, /exactly match the complete recovery callable inventory/);
});

test('Gate 5 requires the exact secret inventory and unique runtime allowlist', () => {
  const audit = read('scripts/gates/audit-production.mjs');
  assert.ok(audit.includes("run(['functions', 'list', '--regions=-', '--project', project])"));
  assert.match(audit, /REQUIRED_SECRETS must contain exactly PHONE_PEPPER and RECOVERY_SIGNING_KEY_PKCS8/);
  assert.match(audit, /RUNTIME_SERVICE_ACCOUNTS contains duplicate identities/);
  assert.match(audit, /new Set\(runtimeAccounts\)/);
});

test('Gate 5 requires the private verifier to trust exactly the configured Functions caller', () => {
  const caller = 'functions@example.iam.gserviceaccount.com';
  assert.equal(hasExactServiceInvoker({ bindings: [{ role: 'roles/run.invoker', members: [`serviceAccount:${caller}`] }] }, caller), true);
  assert.equal(hasExactServiceInvoker({ bindings: [{ role: 'roles/run.invoker', members: [`serviceAccount:${caller}`], condition: { expression: 'true' } }] }, caller), false);
  assert.equal(hasExactServiceInvoker({ bindings: [{ role: 'roles/run.invoker', members: [`serviceAccount:${caller}`, 'serviceAccount:other@example.iam.gserviceaccount.com'] }] }, caller), false);
  assert.equal(hasExactServiceInvoker({ bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }] }, caller), false);
  assert.equal(hasExactServiceInvoker({ bindings: [] }, caller), false);
  assert.equal(hasExactServiceInvoker({ bindings: [
    { role: 'roles/run.invoker', members: [`serviceAccount:${caller}`] },
    { role: 'roles/cloudfunctions.invoker', members: ['serviceAccount:other@example.iam.gserviceaccount.com'] },
  ] }, caller), false);
  assert.equal(hasExactServiceInvoker({ bindings: [{ role: 'roles/run.invoker', members: [`serviceAccount:${caller}`] }] }, 'bad-account'), false);
});

test('Gate 5 paginates the complete production App Check service inventory', () => {
  const audit = read('scripts/gates/audit-production.mjs');
  assert.match(audit, /appCheckUrl\.searchParams\.set\('pageSize', '100'\)/);
  assert.match(audit, /appCheckPageToken = payload\.nextPageToken/);
  assert.match(audit, /seenAppCheckPageTokens\.has\(appCheckPageToken\)/);
});

test('Gate 5 requires a matching regional Cloud Run service for every Gen2 function', () => {
  const functions = [
    { name: 'projects/p/locations/asia-south1/functions/phone', environment: 'GEN_2' },
    { name: 'projects/p/locations/asia-south1/functions/legacy', environment: 'GEN_1' },
  ];
  const services = [
    { metadata: { name: 'phone', labels: { 'cloud.googleapis.com/location': 'asia-south1' } } },
  ];
  assert.deepEqual(findMissingGen2FunctionServices(functions, services), []);
  assert.deepEqual(findMissingGen2FunctionServices([
    ...functions,
    { name: 'projects/p/locations/us-central1/functions/missing', environment: 'GEN_2' },
  ], services), ['missing']);
});

test('Gate 5 rejects project-wide invocation and Secret Manager payload/write grants', () => {
  const risks = findProjectWideRecoveryRisks({ bindings: [
    { role: 'roles/run.invoker', members: ['serviceAccount:unknown@example.iam.gserviceaccount.com'] },
    { role: 'roles/secretmanager.secretAccessor', members: ['user:operator@example.com'] },
    { role: 'roles/secretmanager.secretVersionAdder', members: ['serviceAccount:writer@example.iam.gserviceaccount.com'] },
    { role: 'roles/secretmanager.viewer', members: ['allUsers'] },
  ] });
  assert.deepEqual(risks, [
    { role: 'roles/run.invoker', memberCount: 1 },
    { role: 'roles/secretmanager.secretAccessor', memberCount: 1 },
    { role: 'roles/secretmanager.secretVersionAdder', memberCount: 1 },
  ]);
});

test('Gate 5 rejects inherited project-level public Cloud Run or Functions invocation', () => {
  assert.equal(hasPublicRuntimeInvoker({ bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }] }), true);
  assert.equal(hasPublicRuntimeInvoker({ bindings: [{ role: 'roles/cloudfunctions.invoker', members: ['allAuthenticatedUsers'] }] }), true);
  assert.equal(hasPublicRuntimeInvoker({ bindings: [{ role: 'roles/run.invoker', members: ['serviceAccount:runtime@example.iam.gserviceaccount.com'] }] }), false);
  assert.equal(hasPublicRuntimeInvoker({ bindings: [{ role: 'roles/viewer', members: ['allUsers'] }] }), false);
});

test('Gate 5 enforces exact per-function Secret Manager runtime access', () => {
  const functions = [
    { name: 'projects/p/locations/r/functions/registerRecoveryPhone', serviceConfig: { serviceAccountEmail: 'phone@example.iam.gserviceaccount.com' } },
    { name: 'projects/p/locations/r/functions/issueRecoveryGrant', serviceConfig: { serviceAccountEmail: 'grant@example.iam.gserviceaccount.com' } },
  ];
  const bindings = { registerRecoveryPhone: ['PHONE_PEPPER'], issueRecoveryGrant: ['PHONE_PEPPER', 'RECOVERY_SIGNING_KEY_PKCS8'] };
  const policies = new Map([
    ['PHONE_PEPPER', { bindings: [{ role: 'roles/secretmanager.secretAccessor', members: ['serviceAccount:phone@example.iam.gserviceaccount.com', 'serviceAccount:grant@example.iam.gserviceaccount.com'] }] }],
    ['RECOVERY_SIGNING_KEY_PKCS8', { bindings: [{ role: 'roles/secretmanager.secretAccessor', members: ['serviceAccount:grant@example.iam.gserviceaccount.com'] }] }],
  ]);
  assert.deepEqual(validateFunctionSecretAccess(functions, bindings, policies, ['phone@example.iam.gserviceaccount.com', 'grant@example.iam.gserviceaccount.com'], ['PHONE_PEPPER', 'RECOVERY_SIGNING_KEY_PKCS8']), []);
  const missing = new Map(policies);
  missing.set('RECOVERY_SIGNING_KEY_PKCS8', { bindings: [] });
  assert.match(validateFunctionSecretAccess(functions, bindings, missing, ['phone@example.iam.gserviceaccount.com', 'grant@example.iam.gserviceaccount.com'], ['PHONE_PEPPER', 'RECOVERY_SIGNING_KEY_PKCS8']).join(';'), /accessor set differs/);
  const extra = new Map(policies);
  extra.set('PHONE_PEPPER', { bindings: [{ role: 'roles/secretmanager.secretAccessor', members: ['serviceAccount:phone@example.iam.gserviceaccount.com', 'serviceAccount:grant@example.iam.gserviceaccount.com', 'serviceAccount:unexpected@example.iam.gserviceaccount.com'] }] });
  assert.match(validateFunctionSecretAccess(functions, bindings, extra, ['phone@example.iam.gserviceaccount.com', 'grant@example.iam.gserviceaccount.com'], ['PHONE_PEPPER', 'RECOVERY_SIGNING_KEY_PKCS8']).join(';'), /accessor set differs/);
  assert.match(validateFunctionSecretAccess(functions, bindings, policies, ['phone@example.iam.gserviceaccount.com'], ['PHONE_PEPPER', 'RECOVERY_SIGNING_KEY_PKCS8']).join(';'), /not in RUNTIME_SERVICE_ACCOUNTS/);
  const unrelatedSharesPhoneSecret = [
    ...functions,
    { name: 'projects/p/locations/r/functions/unrelatedProductionFunction', serviceConfig: { serviceAccountEmail: 'phone@example.iam.gserviceaccount.com' } },
  ];
  assert.match(
    validateFunctionSecretAccess(unrelatedSharesPhoneSecret, bindings, policies,
      ['phone@example.iam.gserviceaccount.com', 'grant@example.iam.gserviceaccount.com'],
      ['PHONE_PEPPER', 'RECOVERY_SIGNING_KEY_PKCS8']).join(';'),
    /unmapped function unrelatedProductionFunction shares a recovery secret-bearing runtime identity/,
  );
  const sharedAcrossSecretSets = [
    ...functions,
    { name: 'projects/p/locations/r/functions/acknowledgeRecoveryOwnerAlert', serviceConfig: { serviceAccountEmail: 'phone@example.iam.gserviceaccount.com' } },
  ];
  assert.match(
    validateFunctionSecretAccess(sharedAcrossSecretSets,
      { ...bindings, acknowledgeRecoveryOwnerAlert: [] }, policies,
      ['phone@example.iam.gserviceaccount.com', 'grant@example.iam.gserviceaccount.com'],
      ['PHONE_PEPPER', 'RECOVERY_SIGNING_KEY_PKCS8']).join(';'),
    /share runtime identity.*different secret sets/,
  );
});

test('candidate validation rejects a SHA that differs from the frozen control-branch pin before GitHub API access', (t) => {
  const dir = tempDir(t);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const marker = path.join(dir, 'gh-called');
  const fakeGh = path.join(bin, 'gh');
  fs.writeFileSync(fakeGh, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "called"); process.exit(2);\n`);
  fs.chmodSync(fakeGh, 0o755);
  const result = run(t, 'check-candidate.mjs', ['--sha', SHA_B, '--repo', 'owner/repo', '--branch', 'work/p0-storage-hardening'], {
    PATH: bin + path.delimiter + process.env.PATH,
  }, dir);
  assert.equal(result.status, 1);
  assert.match(output(result), /frozen qualification pin/);
  assert.equal(fs.existsSync(marker), false, 'GitHub API must not be called for an unpinned candidate');
});

test('Gate 5 denies project-wide and non-accessor secret IAM grants', () => {
  const runtime = 'serviceAccount:runtime@example.iam.gserviceaccount.com';
  const audit = 'serviceAccount:audit@example.iam.gserviceaccount.com';
  const allowed = new Set([runtime, audit]);
  const valid = { bindings: [{ role: 'roles/secretmanager.secretAccessor', members: [runtime] }, { role: 'roles/secretmanager.viewer', members: [audit] }] };
  assert.deepEqual(validateSecretPolicy(valid, allowed, ['runtime@example.iam.gserviceaccount.com'], 'audit@example.iam.gserviceaccount.com'), []);
  for (const role of ['roles/secretmanager.secretAccessor', 'roles/secretmanager.admin', 'roles/secretmanager.secretVersionAdder']) {
    assert.match(
      validateSecretPolicy({ bindings: [{ role, members: [audit] }] }, allowed,
        ['runtime@example.iam.gserviceaccount.com'], 'audit@example.iam.gserviceaccount.com').join(';'),
      /audit identity has non-read-only Secret Manager role/,
    );
  }
  assert.match(validateSecretPolicy({ bindings: [{ role: 'roles/secretmanager.admin', members: [runtime] }] }, allowed, ['runtime@example.iam.gserviceaccount.com'], 'audit@example.iam.gserviceaccount.com').join(';'), /unexpected role/);
  assert.match(validateSecretPolicy({ bindings: [{ role: 'roles/secretmanager.secretAccessor', members: [audit] }] }, allowed, ['runtime@example.iam.gserviceaccount.com'], 'audit@example.iam.gserviceaccount.com').join(';'), /audit identity/);
  assert.match(validateSecretPolicy({ bindings: [{ role: 'roles/secretmanager.secretAccessor', members: ['user:someone@example.com'] }] }, allowed, ['runtime@example.iam.gserviceaccount.com'], 'audit@example.iam.gserviceaccount.com').join(';'), /non-service-account/);
});

test('Gate 5 rejects broad project roles on runtime and read-only audit identities', () => {
  const account = 'runtime@example.iam.gserviceaccount.com';
  const policy = { bindings: [
    { role: 'roles/run.admin', members: [`serviceAccount:${account}`] },
    { role: 'roles/secretmanager.secretAccessor', members: [`serviceAccount:${account}`] },
    { role: 'roles/viewer', members: [`serviceAccount:${account}`] },
  ] };
  assert.deepEqual(findPrivilegedProjectRoles(policy, account), ['roles/run.admin', 'roles/secretmanager.secretAccessor']);
  assert.deepEqual(findPrivilegedProjectRoles(policy, 'other@example.iam.gserviceaccount.com'), []);
  for (const role of ['roles/secretmanager.secretVersionAdder', 'roles/secretmanager.secretVersionManager',
    'roles/secretmanager.editor', 'roles/run.developer', 'roles/cloudfunctions.developer',
    'roles/iam.serviceAccountOpenIdTokenCreator']) {
    assert.ok(findPrivilegedProjectRoles({ bindings: [{ role, members: ['serviceAccount:audit@example.iam.gserviceaccount.com'] }] },
      'audit@example.iam.gserviceaccount.com').includes(role), `${role} must be denied to the read-only audit identity`);
  }
  for (const role of ['roles/secretmanager.secretVersionAdder', 'roles/secretmanager.secretVersionManager',
    'roles/secretmanager.editor', 'roles/run.developer', 'roles/cloudfunctions.developer',
    'roles/iam.serviceAccountOpenIdTokenCreator']) {
    assert.ok(findPrivilegedProjectRoles({ bindings: [{ role, members: ['serviceAccount:audit@example.iam.gserviceaccount.com'] }] },
      'audit@example.iam.gserviceaccount.com').includes(role), `${role} must be denied to the read-only audit identity`);
  }
});


test('qualification attestations expire after seven days while allowing small clock skew', () => {
  const now = Date.parse('2026-11-16T12:00:00.000Z');
  assert.equal(isAttestationFresh('2026-11-09T12:00:00.001Z', now), true);
  assert.equal(isAttestationFresh('2026-11-09T12:00:00.000Z', now), false);
  assert.equal(isAttestationFresh('2026-11-09T11:59:59.999Z', now), false);
  assert.equal(isAttestationFresh('2026-11-16T12:04:59.999Z', now), true);
  assert.equal(isAttestationFresh('2026-11-16T12:05:00.001Z', now), false);
  assert.equal(isAttestationFresh('not-a-date', now), false);
  assert.equal(isAttestationFresh(undefined, now), false);
});

test('documented protected environments exactly match workflow references', () => {
  const workflowPaths = [
    '.github/workflows/recovery-staging-deploy.yml',
    '.github/workflows/recovery-attestation-deploy.yml',
    '.github/workflows/gate-4-physical-device.yml',
    '.github/workflows/gate-5-production-security.yml',
    '.github/workflows/gate-manual-attestation.yml',
    '.github/workflows/gate-6-release-signoff.yml',
  ];
  const referenced = new Set();
  for (const workflowPath of workflowPaths) {
    const content = read(workflowPath);
    for (const match of content.matchAll(/^\s*environment:\s*([a-z0-9-]+)\s*$/gm)) {
      referenced.add(match[1]);
    }
  }
  const documented = new Set([
    'recovery-staging',
    'recovery-device',
    'recovery-production-audit',
    'recovery-attestation',
    'recovery-release-owner',
    'recovery-release-review-1',
    'recovery-release-review-2',
  ]);
  assert.deepEqual([...referenced].sort(), [...documented].sort());
  const runbook = read('docs/RECOVERY-GATE-PIPELINE.md');
  for (const environment of documented) assert.ok(runbook.includes('`' + environment + '`'), environment);
  assert.match(runbook, /`RELEASE_OWNER_LOGIN`/);
});



test('acknowledgeRecoveryOwnerAlert is never granted PHONE_PEPPER access', () => {
  const deployWorkflow = read('.github/workflows/recovery-staging-deploy.yml');
  const bindingsMatch = deployWorkflow.match(/bindings=\(\s*([\s\S]*?)\n\s*\)/);
  assert.ok(bindingsMatch, 'staging deployment must declare an explicit callable-to-secret IAM map');
  const alertBinding = bindingsMatch[1].match(/["']acknowledgeRecoveryOwnerAlert:([^"']*)["']/);
  assert.ok(alertBinding, 'acknowledgeRecoveryOwnerAlert must have an explicit least-privilege mapping');
  assert.equal(alertBinding[1].trim(), '', 'acknowledgeRecoveryOwnerAlert must not receive PHONE_PEPPER or any other recovery secret');

  const passkeysSource = read('functions/src/passkeys.ts');
  const alertCallable = passkeysSource.match(/export const acknowledgeRecoveryOwnerAlert = onCall\(([\s\S]*?)\n\);/);
  assert.ok(alertCallable, 'acknowledgeRecoveryOwnerAlert callable declaration must remain explicit');
  assert.doesNotMatch(alertCallable[1], /\bsecrets\s*:/, 'alert acknowledgement must not declare runtime secrets');
  assert.doesNotMatch(passkeysSource, /PHONE_PEPPER/, 'passkeys module must not declare or reference PHONE_PEPPER');
});
