// Read-only release preflight. Checks GitHub configuration names only; secret values are never requested.
// Usage: node scripts/gates/preflight.mjs <owner/repo> <control-branch> roles.json
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const [repo, control, rolesFile] = process.argv.slice(2);
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_.\/-]+$/;
if (!REPO_RE.test(repo ?? '') || !BRANCH_RE.test(control ?? '') || !rolesFile) {
  console.error('usage: preflight.mjs owner/repo branch roles.json');
  process.exit(2);
}

let roles;
try { roles = JSON.parse(fs.readFileSync(rolesFile, 'utf8')); }
catch { console.error('roles.json is missing or invalid JSON'); process.exit(2); }
const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
  if (!ok) failures.push(message);
};
const run = (args) => execFileSync('gh', args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 << 20,
});
const json = (endpoint) => {
  try { return JSON.parse(run(['api', endpoint])); }
  catch (error) { return { __error: String(error.stderr || error.message).replace(/\s+/g, ' ').slice(0, 160) }; }
};
const names = (endpoint, jq) => {
  try {
    return run(['api', '--paginate', endpoint, '--jq', jq])
      .split('\n').map(value => value.trim()).filter(Boolean);
  } catch { return null; }
};
const lower = values => values.map(value => String(value).toLowerCase());
const apiRepo = `repos/${repo}`;
const envNames = [
  'recovery-staging', 'recovery-verifier-deploy', 'recovery-device', 'recovery-production-audit', 'recovery-attestation',
  'recovery-release-owner', 'recovery-release-review-1', 'recovery-release-review-2',
];
const ENVIRONMENT_REQUIREMENTS = {
  'recovery-staging': {
    variables: [
      'STAGING_WEBAUTHN_RP_ID', 'STAGING_WEBAUTHN_RP_NAME', 'STAGING_WEBAUTHN_ANDROID_SHA256_CERT_FINGERPRINTS',
            'GCP_PROJECT_ID', 'PRODUCTION_GCP_PROJECT_ID', 'GCP_REGION',
      'RECOVERY_FUNCTIONS_SERVICE_ACCOUNT', 'RECOVERY_PHONE_SERVICE_ACCOUNT',
      'RECOVERY_GRANT_SERVICE_ACCOUNT', 'RECOVERY_ATTESTATION_SERVICE_ACCOUNT',
      'RECOVERY_ATTESTATION_VERIFIER_URL', 'RECOVERY_SIGNING_KEY_ID',
      'RECOVERY_GRANT_PUBLIC_KEYS_JSON', 'FIREBASE_WEB_API_KEY',
      'ATTESTATION_APP_PACKAGE', 'ATTESTATION_APP_MIN_VERSION',
      'ATTESTATION_APP_SIGNER_SHA256', 'APP_CHECK_PLAY_INTEGRITY_REGISTERED',
      'APP_CHECK_SIGNER_SHA256',
    ],
    secrets: [
      'GCP_WORKLOAD_IDENTITY_PROVIDER',
      'STAGING_DEPLOY_SERVICE_ACCOUNT', 'GOOGLE_SERVICES_JSON_BASE64',
      'STAGING_KEYSTORE_BASE64', 'STAGING_KEYSTORE_PASSWORD', 'STAGING_KEY_ALIAS',
      'STAGING_KEY_PASSWORD',
    ],
  },
  'recovery-device': { variables: ['DEVICE_SERIAL', 'DEVICE_SERIAL_ALLOWLIST'], secrets: [] },
  'recovery-production-audit': {
    variables: [
      'PRODUCTION_GCP_PROJECT_ID', 'PRODUCTION_RECOVERY_SIGNING_KEY_ID', 'ATTESTATION_VERIFIER_SERVICE',
      'ATTESTATION_VERIFIER_CALLER_SERVICE_ACCOUNT', 'REQUIRED_SECRETS',
      'RUNTIME_SERVICE_ACCOUNTS', 'APPCHECK_REQUIRED_SERVICES',
      'FIREBASE_ANDROID_APP_IDS', 'FIREBASE_ALLOWED_SHA1', 'FIREBASE_ALLOWED_SHA256',
    ],
    oneOfVariables: [['PRODUCTION_GCP_REGION', 'GCP_REGION']],
    secrets: ['GCP_WORKLOAD_IDENTITY_PROVIDER', 'GCP_AUDIT_SERVICE_ACCOUNT'],
  },
  'recovery-verifier-deploy': {
    variables: ['GCP_PROJECT_ID', 'PRODUCTION_GCP_PROJECT_ID', 'GCP_REGION', 'RECOVERY_ATTESTATION_SERVICE_ACCOUNT', 'RECOVERY_FUNCTIONS_SERVICE_ACCOUNT', 'ATTESTATION_APP_PACKAGE', 'ATTESTATION_APP_MIN_VERSION', 'ATTESTATION_APP_SIGNER_SHA256'],
    secrets: ['GCP_WORKLOAD_IDENTITY_PROVIDER', 'VERIFIER_DEPLOY_SERVICE_ACCOUNT'],
  },
  'recovery-attestation': { variables: [], secrets: [] },
  'recovery-release-owner': {
    variables: ['PRODUCTION_GCP_PROJECT_ID', 'PRODUCTION_RECOVERY_SIGNING_KEY_ID', 'PRODUCTION_RECOVERY_GRANT_PUBLIC_KEYS_JSON'],
    secrets: ['PRODUCTION_GOOGLE_SERVICES_JSON_BASE64', 'PRODUCTION_KEYSTORE_BASE64',
      'PRODUCTION_KEYSTORE_PASSWORD', 'PRODUCTION_KEY_ALIAS', 'PRODUCTION_KEY_PASSWORD'],
  },
  'recovery-release-review-1': { variables: [], secrets: [] },
  'recovery-release-review-2': { variables: [], secrets: [] },
};

// 1. Six distinct human logins.
const roleKeys = ['maintainer', 'operator', 'tester', 'owner', 'reviewer1', 'reviewer2'];
const logins = roleKeys.map(key => String(roles?.[key] ?? '').toLowerCase());
check(logins.every(login => /^[a-z0-9-]{1,39}$/.test(login)) && new Set(logins).size === 6,
  'six distinct valid GitHub logins');

// 2. Protected environments, reviewer separation and branch policy.
const environmentReviewRules = {
  'recovery-release-owner': { only: roles?.owner },
  'recovery-release-review-1': { only: roles?.reviewer1 },
  'recovery-release-review-2': { only: roles?.reviewer2 },
  'recovery-attestation': { exclude: [roles?.maintainer, roles?.tester, roles?.operator] },
  'recovery-staging': { exclude: [roles?.maintainer, roles?.tester, roles?.operator] },
  'recovery-verifier-deploy': { exclude: [roles?.maintainer, roles?.tester, roles?.operator] },
  'recovery-device': { exclude: [roles?.maintainer, roles?.tester, roles?.operator] },
  'recovery-production-audit': { exclude: [roles?.maintainer, roles?.tester, roles?.operator] },
};
const environmentState = new Map();
for (const name of envNames) {
  const environment = json(`${apiRepo}/environments/${encodeURIComponent(name)}`);
  if (environment.__error) {
    check(false, `${name}: cannot read environment (${environment.__error})`);
    environmentState.set(name, { variables: null, secrets: null });
    continue;
  }
  const requiredReviewers = (environment.protection_rules ?? []).filter(rule => rule.type === 'required_reviewers');
  const reviewers = requiredReviewers.flatMap(rule => (rule.reviewers ?? []).map(item => ({
    type: item.type, login: item.reviewer?.login ?? item.reviewer?.slug ?? '',
  })));
  check(requiredReviewers.length > 0 && reviewers.length > 0, `${name}: has required reviewers`);
  check(requiredReviewers.length > 0 && requiredReviewers.every(rule => rule.prevent_self_review === true),
    `${name}: prevent_self_review enabled`);
  check(environment.can_admins_bypass === false, `${name}: administrators cannot bypass protection`);
  const branchPolicies = names(`${apiRepo}/environments/${encodeURIComponent(name)}/deployment-branch-policies`, '.branch_policies[].name');
  check(branchPolicies !== null && branchPolicies.length === 1 && branchPolicies[0] === control &&
    environment.deployment_branch_policy?.custom_branch_policies === true,
  `${name}: deployment restricted to ${control}`);
  const rule = environmentReviewRules[name];
  const reviewerLogins = lower(reviewers.map(reviewer => reviewer.login));
  if (Object.hasOwn(rule, 'only')) {
    const expectedLogin = String(rule.only ?? '').toLowerCase();
    check(reviewers.length === 1 && reviewers[0].type === 'User' && reviewerLogins[0] === expectedLogin,
      `${name}: sole reviewer is the assigned person`);
  } else {
    const excludedLogins = lower((rule.exclude ?? []).filter(Boolean));
    check(reviewers.length > 0 && reviewers.every(reviewer => reviewer.type === 'User'),
      `${name}: reviewer identities are individually verifiable`);
    check(!reviewerLogins.some(login => excludedLogins.includes(login)),
      `${name}: reviewers exclude maintainer, operator and tester`);
  }
  environmentState.set(name, { variables: null, secrets: null });
}

// 3. Required variable/secret inventory. Only names are emitted; values are never printed or persisted.
const repoVariables = names(`${apiRepo}/actions/variables`, '.variables[].name');
const repoSecrets = names(`${apiRepo}/actions/secrets`, '.secrets[].name');
check(repoVariables !== null, 'repository variable names are readable');
check(repoSecrets !== null, 'repository secret names are readable');
if (repoSecrets !== null) check(repoSecrets.includes('DIGITAL_ASSET_LINKS_API_KEY'), 'repository secret DIGITAL_ASSET_LINKS_API_KEY exists');
if (repoVariables !== null) {
  for (const required of ['RELEASE_OWNER_LOGIN', 'RECOVERY_GRANT_PUBLIC_KEYS_JSON', 'WEBAUTHN_RP_ID', 'WEBAUTHN_RP_NAME', 'WEBAUTHN_ANDROID_SHA256_CERT_FINGERPRINTS', 'ANDROID_APPLICATION_ID', 'PRODUCTION_KEY_VERIFY_SERVICE_ACCOUNT', 'PRODUCTION_KEY_VERIFY_WIF_PRINCIPAL', 'PRODUCTION_KEY_VERIFY_WIF_PROVIDER']) {
    check(repoVariables.includes(required), `repository variable ${required} exists`);
  }
}
const keyVerifierRepoVariables = ['PRODUCTION_KEY_VERIFY_SERVICE_ACCOUNT', 'PRODUCTION_KEY_VERIFY_WIF_PRINCIPAL', 'PRODUCTION_KEY_VERIFY_WIF_PROVIDER'];
for (const [environment, requirement] of Object.entries(ENVIRONMENT_REQUIREMENTS)) {
  const variableNames = names(`${apiRepo}/environments/${encodeURIComponent(environment)}/variables`, '.variables[].name');
  const secretNames = names(`${apiRepo}/environments/${encodeURIComponent(environment)}/secrets`, '.secrets[].name');
  environmentState.set(environment, { variables: variableNames, secrets: secretNames });
  check(variableNames !== null, `${environment}: variable names are readable`);
  check(secretNames !== null, `${environment}: secret names are readable`);
  if (variableNames === null || secretNames === null) continue;
  for (const required of requirement.variables) check(variableNames.includes(required), `${environment}: required variable ${required} exists`);
  for (const alternatives of requirement.oneOfVariables ?? []) {
    check(alternatives.some(name => variableNames.includes(name)), `${environment}: one of ${alternatives.join(' or ')} exists`);
  }
  for (const required of requirement.secrets) check(secretNames.includes(required), `${environment}: required secret ${required} exists`);
}
for (const required of keyVerifierRepoVariables) {
  const environmentOccurrences = envNames.filter(environment => environmentState.get(environment)?.variables?.includes(required));
  check(repoVariables?.includes(required) && environmentOccurrences.length === 0,
    `${required} is defined only as a repository variable (no environment overrides)`);
}

// 4. Audit identity must exist only as a secret in the production audit environment.
const auditIdentity = 'GCP_AUDIT_SERVICE_ACCOUNT';
const auditOccurrences = [];
if (repoVariables?.includes(auditIdentity)) auditOccurrences.push('repository variables');
if (repoSecrets?.includes(auditIdentity)) auditOccurrences.push('repository secrets');
for (const environment of envNames) {
  const state = environmentState.get(environment);
  if (state?.variables?.includes(auditIdentity)) auditOccurrences.push(`${environment} variables`);
  if (state?.secrets?.includes(auditIdentity)) auditOccurrences.push(`${environment} secrets`);
}
check(auditOccurrences.length === 1 && auditOccurrences[0] === 'recovery-production-audit secrets',
  `${auditIdentity} exists only as a secret in recovery-production-audit`);

// 5. Secret material belongs in Google Secret Manager, never GitHub Actions.
const forbiddenNames = ['PHONE_PEPPER', 'RECOVERY_SIGNING_KEY_PKCS8'];
const githubNameLocations = [];
for (const secretName of forbiddenNames) {
  if (repoSecrets?.includes(secretName)) githubNameLocations.push(`repository secret ${secretName}`);
  if (repoVariables?.includes(secretName)) githubNameLocations.push(`repository variable ${secretName}`);
  for (const environment of envNames) {
    const state = environmentState.get(environment);
    if (state?.secrets?.includes(secretName)) githubNameLocations.push(`${environment} secret ${secretName}`);
    if (state?.variables?.includes(secretName)) githubNameLocations.push(`${environment} variable ${secretName}`);
  }
}
check(githubNameLocations.length === 0,
  githubNameLocations.length ? `Secret Manager-only credentials found in GitHub names: ${githubNameLocations.join(', ')}` :
    'PHONE_PEPPER and RECOVERY_SIGNING_KEY_PKCS8 are not stored in GitHub Actions');

// 6. Branch protection.
const encodedControl = control.split('/').map(encodeURIComponent).join('%2F');
const protection = json(`${apiRepo}/branches/${encodedControl}/protection`);
if (protection.__error) check(false, `${control}: branch protection cannot be read (${protection.__error})`);
else {
  check((protection.required_pull_request_reviews?.required_approving_review_count ?? 0) >= 1, 'branch: at least one PR approval required');
  check(protection.required_pull_request_reviews?.dismiss_stale_reviews === true, 'branch: stale approvals dismissed after new commits');
  check(protection.enforce_admins?.enabled === true, 'branch: rules enforced for administrators');
  check(protection.allow_force_pushes?.enabled === false && protection.allow_deletions?.enabled === false,
    'branch: force-push and deletion disabled');
  check((protection.required_status_checks?.contexts?.length ?? 0) + (protection.required_status_checks?.checks?.length ?? 0) > 0,
    'branch: required status checks configured');
}

// 7. Physical-device runner presence. Offline is reported, not treated as ready for dispatch.
const runners = names(`${apiRepo}/actions/runners`, '.runners[] | [.name, .status, (.labels | map(.name) | join(","))] | @tsv');
const deviceRunners = (runners ?? []).filter(line => {
  const labels = new Set(line.split('\t')[2]?.split(',') ?? []);
  return labels.has('aurelia-android-device') && labels.has('linux') && labels.has('x64');
});
check(runners !== null && deviceRunners.length === 1,
  `exactly one Linux x64 runner labelled aurelia-android-device (${deviceRunners.length} found)`);
if (deviceRunners[0]) console.log(`INFO  physical runner status: ${deviceRunners[0].split('\t')[1]} (must be online before Gate 4 dispatch)`);

console.log(failures.length ? `\n${failures.length} check(s) FAILED - do not freeze or dispatch` :
  '\nAll automated preflight checks passed. Handset facts and real GCP/Firebase behavior still require live qualification.');
process.exit(failures.length ? 1 : 0);
