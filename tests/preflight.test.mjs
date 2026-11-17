import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/gates/preflight.mjs');
const roles = {
  maintainer: 'maintainer-one', operator: 'operator-one', tester: 'tester-one',
  owner: 'owner-one', reviewer1: 'reviewer-one', reviewer2: 'reviewer-two',
};
const envs = {
  'recovery-staging': {
    variables: ['GCP_PROJECT_ID','PRODUCTION_GCP_PROJECT_ID','GCP_REGION','RECOVERY_FUNCTIONS_SERVICE_ACCOUNT',
      'RECOVERY_PHONE_SERVICE_ACCOUNT','RECOVERY_GRANT_SERVICE_ACCOUNT','RECOVERY_ATTESTATION_SERVICE_ACCOUNT',
      'RECOVERY_ATTESTATION_VERIFIER_URL','RECOVERY_SIGNING_KEY_ID','RECOVERY_GRANT_PUBLIC_KEYS_JSON',
      'FIREBASE_WEB_API_KEY','ATTESTATION_APP_PACKAGE','ATTESTATION_APP_MIN_VERSION','ATTESTATION_APP_SIGNER_SHA256',
      'APP_CHECK_PLAY_INTEGRITY_REGISTERED','APP_CHECK_SIGNER_SHA256'],
    secrets: ['GCP_WORKLOAD_IDENTITY_PROVIDER','GCP_DEPLOY_SERVICE_ACCOUNT','STAGING_DEPLOY_SERVICE_ACCOUNT',
      'GOOGLE_SERVICES_JSON_BASE64','STAGING_KEYSTORE_BASE64','STAGING_KEYSTORE_PASSWORD','STAGING_KEY_ALIAS','STAGING_KEY_PASSWORD'],
  },
  'recovery-device': { variables: ['DEVICE_SERIAL','DEVICE_SERIAL_ALLOWLIST'], secrets: [] },
  'recovery-production-audit': {
    variables: ['PRODUCTION_GCP_PROJECT_ID','PRODUCTION_RECOVERY_SIGNING_KEY_ID','PRODUCTION_GCP_REGION','ATTESTATION_VERIFIER_SERVICE',
      'ATTESTATION_VERIFIER_CALLER_SERVICE_ACCOUNT','REQUIRED_SECRETS','RUNTIME_SERVICE_ACCOUNTS',
      'APPCHECK_REQUIRED_SERVICES','FIREBASE_ANDROID_APP_IDS','FIREBASE_ALLOWED_SHA1','FIREBASE_ALLOWED_SHA256','PRODUCTION_KEY_VERIFY_SERVICE_ACCOUNT','PRODUCTION_KEY_VERIFY_WIF_PRINCIPAL'],
    secrets: ['GCP_WORKLOAD_IDENTITY_PROVIDER','GCP_AUDIT_SERVICE_ACCOUNT'],
  },
  'recovery-attestation': { variables: [], secrets: [] },
  'recovery-release-owner': {
    variables: ['PRODUCTION_GCP_PROJECT_ID','PRODUCTION_RECOVERY_SIGNING_KEY_ID','PRODUCTION_RECOVERY_GRANT_PUBLIC_KEYS_JSON'],
    secrets: ['PRODUCTION_GOOGLE_SERVICES_JSON_BASE64','PRODUCTION_KEYSTORE_BASE64','PRODUCTION_KEYSTORE_PASSWORD','PRODUCTION_KEY_ALIAS','PRODUCTION_KEY_PASSWORD'],
  },
  'recovery-release-review-1': { variables: [], secrets: [] },
  'recovery-release-review-2': { variables: [], secrets: [] },
};
function fixture(faults = []) {
  const state = structuredClone(envs);
  for (const fault of faults) {
    const [kind, environment, name] = fault.split(':');
    if (kind === 'remove-variable') state[environment].variables = state[environment].variables.filter(item => item !== name);
    if (kind === 'remove-secret') state[environment].secrets = state[environment].secrets.filter(item => item !== name);
    if (kind === 'add-secret') state[environment].secrets.push(name);
    if (kind === 'remove-repo-variable') state.repoVariables = ['RELEASE_OWNER_LOGIN'];
  }
  return state;
}
function execute(t, faults = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurelia-preflight-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const rolesFile = path.join(dir, 'roles.json'); fs.writeFileSync(rolesFile, JSON.stringify(roles));
  const fakeGh = path.join(bin, 'gh');
  const fake = `#!/usr/bin/env node
const args = process.argv.slice(2);
const state = JSON.parse(process.env.FAKE_STATE);
const repoVars = state.repoVariables ?? ['RELEASE_OWNER_LOGIN', 'RECOVERY_GRANT_PUBLIC_KEYS_JSON', 'WEBAUTHN_RP_ID', 'WEBAUTHN_RP_NAME', 'WEBAUTHN_ANDROID_SHA256_CERT_FINGERPRINTS', 'ANDROID_APPLICATION_ID', 'PRODUCTION_KEY_VERIFY_WIF_PROVIDER'];
const repoSecrets = state.repoSecrets ?? ['DIGITAL_ASSET_LINKS_API_KEY'];
const reviewers = state.reviewers ?? {
  'recovery-release-owner': 'owner-one',
  'recovery-release-review-1': 'reviewer-one',
  'recovery-release-review-2': 'reviewer-two',
  'recovery-attestation': 'reviewer-one',
  'recovery-staging': 'reviewer-one',
  'recovery-device': 'reviewer-one',
  'recovery-production-audit': 'reviewer-two'
};
if (args[0] !== 'api') process.exit(2);
const paginate = args[1] === '--paginate';
const endpoint = paginate ? args[2] : args[1];
const jq = paginate ? args[4] : '';
let output;
const parts = endpoint.split('/');
const environmentIndex = parts.indexOf('environments');
if (environmentIndex >= 0) {
  const name = decodeURIComponent(parts[environmentIndex + 1]);
  const suffix = parts[environmentIndex + 2];
  if (suffix === 'variables') output = state[name]?.variables ?? [];
  else if (suffix === 'secrets') output = state[name]?.secrets ?? [];
  else if (suffix === 'deployment-branch-policies') output = [{ name: state.branchPolicy }];
  else output = { can_admins_bypass: false, deployment_branch_policy: { custom_branch_policies: true }, protection_rules: [{ type: 'required_reviewers', prevent_self_review: true, reviewers: [{ type: 'User', reviewer: { login: reviewers[name] } }] }] };
} else if (endpoint.endsWith('/actions/variables')) output = repoVars;
else if (endpoint.endsWith('/actions/secrets')) output = repoSecrets;
else if (endpoint.endsWith('/branches/integration%2Fledger-patch/protection')) output = { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false }, required_status_checks: { contexts: ['ci'] } };
else if (endpoint.endsWith('/actions/runners')) output = [{ name: 'device-runner', status: 'online', labels: [{ name: 'self-hosted' }, { name: 'linux' }, { name: 'x64' }, { name: 'aurelia-android-device' }] }];
else process.exit(3);
if (paginate) {
  const values = Array.isArray(output) ? output : [];
  if (jq.includes('.branch_policies')) process.stdout.write(values.map(x => x.name).join('\\n') + (values.length ? '\\n' : ''));
  else if (jq.includes('map(.name)')) process.stdout.write(values.map(x => [x.name,x.status,x.labels.map(l=>l.name).join(',')].join('\\t')).join('\\n') + (values.length ? '\\n' : ''));
  else process.stdout.write(values.join('\\n') + (values.length ? '\\n' : ''));
} else console.log(JSON.stringify(output));
`;
  fs.writeFileSync(fakeGh, fake); fs.chmodSync(fakeGh, 0o755);
  const state = fixture(faults);
  if (faults.includes('maintainer-approval')) state.reviewers = { 'recovery-staging': 'maintainer-one' };
  if (faults.includes('remove-repo-secret')) state.repoSecrets = [];
  state.branchPolicy = faults.includes('wrong-branch-policy') ? 'main' : 'integration/ledger-patch';
  if (faults.includes('add-repo-secret:GCP_AUDIT_SERVICE_ACCOUNT')) state.repoSecrets = ['GCP_AUDIT_SERVICE_ACCOUNT'];
  const result = spawnSync(process.execPath, [script, 'owner/repo', 'integration/ledger-patch', rolesFile], {
    cwd: dir,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_STATE: JSON.stringify(state) },
    encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024,
  });
  return { result, output: `${result.stdout}\n${result.stderr}` };
}

test('preflight passes when all required names and protections are present', t => {
  const { result, output } = execute(t);
  assert.equal(result.status, 0, output);
  assert.match(output, /All automated preflight checks passed/);
  assert.doesNotMatch(output, /secret-value|private-key-material/);
});

test('preflight fails closed on missing variable, missing secret, misplaced audit identity, banned secret and wrong branch policy', t => {
  const { result, output } = execute(t, [
    'remove-variable:recovery-staging:GCP_PROJECT_ID',
    'remove-secret:recovery-staging:STAGING_KEYSTORE_PASSWORD',
    'add-repo-secret:GCP_AUDIT_SERVICE_ACCOUNT',
    'add-secret:recovery-staging:PHONE_PEPPER',
    'wrong-branch-policy',
  ]);
  assert.equal(result.status, 1, output);
  assert.match(output, /recovery-staging: required variable GCP_PROJECT_ID exists/);
  assert.match(output, /recovery-staging: required secret STAGING_KEYSTORE_PASSWORD exists/);
  assert.match(output, /GCP_AUDIT_SERVICE_ACCOUNT exists only as a secret/);
  assert.match(output, /Secret Manager-only credentials found in GitHub names/);
  assert.match(output, /deployment restricted to integration\/ledger-patch/);
});

test('preflight never prints secret values and requires the audit identity in the correct environment', t => {
  const { result, output } = execute(t);
  assert.equal(result.status, 0, output);
  assert.match(output, /GCP_AUDIT_SERVICE_ACCOUNT exists only as a secret in recovery-production-audit/);
  assert.doesNotMatch(output, /secret-value|private-key-material|BEGIN PRIVATE KEY/);
});

test('preflight requires the Digital Asset Links API repository secret', t => {
  const { result, output } = execute(t, ['remove-repo-secret']);
  assert.equal(result.status, 1, output);
  assert.match(output, /repository secret DIGITAL_ASSET_LINKS_API_KEY exists/);
});

test('preflight requires the documented repository-level public key ring variable', t => {
  const { result, output } = execute(t, ['remove-repo-variable']);
  assert.equal(result.status, 1, output);
  assert.match(output, /repository variable RECOVERY_GRANT_PUBLIC_KEYS_JSON exists/);
});

test('preflight rejects the maintainer as an operational environment approver and rejects both Secret Manager-only names in GitHub', t => {
  const { result, output } = execute(t, [
    'add-secret:recovery-device:RECOVERY_SIGNING_KEY_PKCS8',
    'maintainer-approval',
  ]);
  assert.equal(result.status, 1, output);
  assert.match(output, /reviewers exclude maintainer, operator and tester/);
  assert.match(output, /Secret Manager-only credentials found in GitHub names/);
});
