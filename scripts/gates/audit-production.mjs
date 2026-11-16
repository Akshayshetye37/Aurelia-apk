import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fail } from './lib.mjs';
import { countTestPhoneNumbers, validateFirebaseFingerprintInventory, firebaseAndroidShaEndpoint, hasPublicRuntimeInvoker, validateFunctionSecretAccess } from './firebase-audit-schema.mjs';

const project = process.env.GCP_PROJECT_ID;
const region = process.env.GCP_REGION;
if (!project || project !== process.env.PRODUCTION_GCP_PROJECT_ID) fail('project is not the declared production project');
const list = (name) => (process.env[name] ?? '').split(',').map((value) => value.trim()).filter(Boolean);
const run = (args) => {
  try { return JSON.parse(execFileSync('gcloud', [...args, '--format=json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })); }
  catch (error) { fail(`gcloud ${args.slice(0, 3).join(' ')} failed: ${error.stderr?.toString().slice(0, 400) || error.message}`); }
};
const problems = [];
const protectedFlagNames = new Set([
  'RECOVERY_ENABLED',
  'LIVE_COLLECTION', 'LIVE_COLLECTION_ENABLED',
  'AUTOMATIC_SETTLEMENT', 'AUTOMATIC_SETTLEMENT_ENABLED',
  'AUTOMATIC_REFUND', 'AUTOMATIC_REFUNDS', 'AUTOMATIC_REFUND_ENABLED', 'AUTOMATIC_REFUNDS_ENABLED',
  'CLOUD_SYNC', 'CLOUD_SYNC_ENABLED',
  'uiCutover',
  'BT_PRINTING_ENABLED',
]);
const off = (v) => v === undefined || v === null || ['false', '0', 'off', 'disabled', 'no', ''].includes(String(v).trim().toLowerCase());
const auditedResources = { functions: 0, runServices: 0, protectedFlagVariables: 0 };
function inspectFlag(name, value, resource) {
  if (!protectedFlagNames.has(name)) return;
  auditedResources.protectedFlagVariables++;
  if (!off(value)) problems.push(`${resource}: ${name} is not OFF`);
}
function inspectFunctionEnv(resource, env) {
  for (const [name, value] of Object.entries(env ?? {})) inspectFlag(name, value, resource);
}
function inspectSecretFlag(resource, entries) {
  for (const entry of entries ?? []) {
    const name = entry.key ?? entry.name;
    if (protectedFlagNames.has(name)) {
      auditedResources.protectedFlagVariables++;
      problems.push(`${resource}: ${name} is secret-sourced and cannot be proven OFF`);
    }
  }
}
const functions = run(['functions', 'list', '--project', project]);
auditedResources.functions = functions.length;
if (!functions.length) problems.push('no production Cloud Functions found; runtime flags cannot be verified');
for (const f of functions) {
  const resource = `function ${f.name}`;
  const config = f.serviceConfig ?? f;
  inspectFunctionEnv(resource, config.environmentVariables ?? f.environmentVariables);
  inspectSecretFlag(resource, config.secretEnvironmentVariables ?? f.secretEnvironmentVariables);
}
const services = run(['run', 'services', 'list', '--project', project]);
auditedResources.runServices = services.length;
for (const service of services) {
  const resource = `run service ${service.metadata?.name ?? service.name}`;
  const containers = service.spec?.template?.spec?.containers ?? service.template?.containers ?? [];
  for (const container of containers) {
    for (const entry of container.env ?? []) {
      if (!protectedFlagNames.has(entry.name)) continue;
      auditedResources.protectedFlagVariables++;
      if (entry.valueSource || entry.valueFrom) problems.push(`${resource}: ${entry.name} is secret-sourced and cannot be proven OFF`);
      else if (!off(entry.value)) problems.push(`${resource}: ${entry.name} is not OFF`);
    }
  }
}
const verifier = process.env.ATTESTATION_VERIFIER_SERVICE;
if (!verifier || !region) problems.push('ATTESTATION_VERIFIER_SERVICE and GCP_REGION must be configured');
else {
  const policy = run(['run', 'services', 'get-iam-policy', verifier, '--region', region, '--project', project]);
  for (const binding of policy.bindings ?? []) for (const member of binding.members ?? []) {
    if (member === 'allUsers' || member === 'allAuthenticatedUsers') problems.push(`attestation verifier is public (${binding.role})`);
  }
}
const runtimeAccounts = list('RUNTIME_SERVICE_ACCOUNTS');
const auditServiceAccount = process.env.AUDIT_SERVICE_ACCOUNT ?? '';
if (!runtimeAccounts.length) problems.push('RUNTIME_SERVICE_ACCOUNTS not configured');
if (!auditServiceAccount) problems.push('AUDIT_SERVICE_ACCOUNT not configured');
if (auditServiceAccount && runtimeAccounts.includes(auditServiceAccount)) problems.push('audit identity must be distinct from every production runtime identity');
const requiredSecrets = list('REQUIRED_SECRETS');
const secretPolicies = new Map();
const allowedSecretPrincipals = new Set([...runtimeAccounts, auditServiceAccount].filter(Boolean).map((account) => `serviceAccount:${account}`));
if (!requiredSecrets.length) problems.push('REQUIRED_SECRETS not configured');
for (const secret of requiredSecrets) {
  const versions = run(['secrets', 'versions', 'list', secret, '--project', project, '--filter=state=ENABLED']);
  if (!Array.isArray(versions) || versions.length === 0) problems.push(`secret ${secret}: no enabled version`);
  const policy = run(['secrets', 'get-iam-policy', secret, '--project', project]);
  secretPolicies.set(secret, policy);
  for (const binding of policy.bindings ?? []) for (const member of binding.members ?? []) {
    if (!member.startsWith('serviceAccount:')) problems.push(`secret ${secret}: non-service-account member`);
    else if (!allowedSecretPrincipals.has(member)) problems.push(`secret ${secret}: unexpected service-account member`);
    if (auditServiceAccount && member === `serviceAccount:${auditServiceAccount}` && ['roles/secretmanager.secretAccessor', 'roles/secretmanager.admin'].includes(binding.role)) problems.push(`secret ${secret}: audit identity has secret payload/admin access`);
  }
}
const runtimeSecretBindings = {
  registerRecoveryPhone: ['PHONE_PEPPER'],
  registerRecoveryOwnerDevice: ['PHONE_PEPPER'],
  acknowledgeRecoveryOwnerAlert: ['PHONE_PEPPER'],
  issueRecoveryGrant: ['PHONE_PEPPER', 'RECOVERY_SIGNING_KEY_PKCS8'],
  consumeRecoveryGrant: ['PHONE_PEPPER', 'RECOVERY_SIGNING_KEY_PKCS8'],
};
problems.push(...validateFunctionSecretAccess(functions, runtimeSecretBindings, secretPolicies, runtimeAccounts, requiredSecrets));
const reviewedAccounts = [...new Set([...runtimeAccounts, auditServiceAccount].filter(Boolean))];
for (const account of reviewedAccounts) {
  const keys = run(['iam', 'service-accounts', 'keys', 'list', '--iam-account', account, '--managed-by=user', '--project', project]);
  if (keys.length) problems.push(`${account}: user-managed keys exist`);
  const policy = run(['iam', 'service-accounts', 'get-iam-policy', account, '--project', project]);
  for (const binding of policy.bindings ?? []) {
    if (['roles/owner', 'roles/editor'].includes(binding.role) && (binding.members ?? []).includes(`serviceAccount:${account}`)) {
      problems.push(`${account}: holds ${binding.role}`);
    }
  }
}
const requiredAppCheckServices = list('APPCHECK_REQUIRED_SERVICES');
if (!requiredAppCheckServices.length) problems.push('APPCHECK_REQUIRED_SERVICES not configured');
const projectPolicy = run(['projects', 'get-iam-policy', project]);
if (hasPublicRuntimeInvoker(projectPolicy)) problems.push('project-level IAM grants public Cloud Run/Functions invocation');
for (const account of reviewedAccounts) {
  for (const binding of projectPolicy.bindings ?? []) {
    if ((['roles/owner', 'roles/editor', 'roles/secretmanager.admin'].includes(binding.role) || (account === auditServiceAccount && binding.role === 'roles/secretmanager.secretAccessor')) && (binding.members ?? []).includes(`serviceAccount:${account}`)) {
      problems.push(`${account}: project-level ${binding.role}`);
    }
  }
}

const firebaseAppIds = list('FIREBASE_ANDROID_APP_IDS'), allowedSha1 = list('FIREBASE_ALLOWED_SHA1'), allowedSha256 = list('FIREBASE_ALLOWED_SHA256');
if (!firebaseAppIds.length || new Set(firebaseAppIds).size !== firebaseAppIds.length) problems.push('FIREBASE_ANDROID_APP_IDS must contain unique production Android app IDs');
if (!allowedSha1.length || !allowedSha256.length) problems.push('FIREBASE_ALLOWED_SHA1 and FIREBASE_ALLOWED_SHA256 must both be configured');
const accessToken = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim();
async function firebaseGet(url, label) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) fail(`${label} API returned ${response.status}`);
  return response.json();
}
const firebaseAudit = { androidApps:0, sha1Fingerprints:0, sha256Fingerprints:0, projectTestPhoneNumbers:0, tenantTestPhoneNumbers:0, tenants:0 };
if (firebaseAppIds.length && allowedSha1.length && allowedSha256.length) {
  const apps=[]; let pageToken;
  do {
    const url=new URL(`https://firebase.googleapis.com/v1beta1/projects/${encodeURIComponent(project)}/androidApps`);
    url.searchParams.set('pageSize','100'); if(pageToken) url.searchParams.set('pageToken',pageToken);
    const page=await firebaseGet(url,'Firebase Android app inventory'); apps.push(...(page.apps??[])); pageToken=page.nextPageToken;
  } while(pageToken);
  const fingerprintsByApp={};
  for(const appId of firebaseAppIds) {
    const payload=await firebaseGet(firebaseAndroidShaEndpoint(project, appId),`Firebase signing fingerprints for ${appId}`);
    fingerprintsByApp[appId]=payload.certificates??[];
  }
  try { Object.assign(firebaseAudit,validateFirebaseFingerprintInventory(apps,fingerprintsByApp,firebaseAppIds,allowedSha1,allowedSha256)); }
  catch(error) { problems.push(error.message); }
}
const authConfig=await firebaseGet(`https://identitytoolkit.googleapis.com/admin/v2/projects/${encodeURIComponent(project)}/config`,'Firebase Auth project configuration');
firebaseAudit.projectTestPhoneNumbers=countTestPhoneNumbers(authConfig);
if(firebaseAudit.projectTestPhoneNumbers) problems.push('production Firebase Auth project has test phone numbers configured');
let tenantPageToken;
do {
  const url=new URL(`https://identitytoolkit.googleapis.com/admin/v2/projects/${encodeURIComponent(project)}/tenants`);
  url.searchParams.set('pageSize','100'); if(tenantPageToken) url.searchParams.set('pageToken',tenantPageToken);
  const page=await firebaseGet(url,'Firebase Auth tenant inventory');
  for(const tenant of page.tenants??[]) {
    firebaseAudit.tenants++;
    const config=await firebaseGet(`https://identitytoolkit.googleapis.com/admin/v2/${tenant.name.split('/').map(encodeURIComponent).join('/')}`,'Firebase Auth tenant configuration');
    const count=countTestPhoneNumbers(config); firebaseAudit.tenantTestPhoneNumbers+=count;
    if(count) problems.push(`Firebase Auth tenant ${tenant.name.split('/').pop()} has test phone numbers configured`);
  }
  tenantPageToken=page.nextPageToken;
} while(tenantPageToken);
if(firebaseAudit.tenantTestPhoneNumbers) problems.push('production Firebase Auth tenants have test phone numbers configured');

const token = accessToken;
const appCheck = await fetch(`https://firebaseappcheck.googleapis.com/v1/projects/${encodeURIComponent(project)}/services`, {
  headers: { Authorization: `Bearer ${token}`, 'X-Goog-User-Project': project },
  signal: AbortSignal.timeout(15_000),
});
if (!appCheck.ok) problems.push(`App Check API returned ${appCheck.status}`);
else {
  const payload = await appCheck.json();
  const modes = Object.fromEntries((payload.services ?? []).map((service) => [service.name.split('/').pop(), service.enforcementMode]));
  for (const service of requiredAppCheckServices) if (modes[service] !== 'ENFORCED') problems.push(`App Check not ENFORCED for ${service}`);
}
fs.mkdirSync('evidence', { recursive: true });
fs.writeFileSync('evidence/production-audit.json', JSON.stringify({ project, checkedAt: new Date().toISOString(), auditedResources, firebaseAudit, problems }, null, 2));
if (problems.length) fail(problems.join('; '));
console.log('production audit clean: recovery OFF everywhere');
