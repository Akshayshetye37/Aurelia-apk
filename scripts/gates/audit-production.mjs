import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fail } from './lib.mjs';
import { countTestPhoneNumbers, validateFirebaseFingerprintInventory, firebaseAndroidShaEndpoint, hasPublicRuntimeInvoker, hasExactServiceInvoker, findProjectWideRecoveryRisks, findMissingGen2FunctionServices, validateFunctionSecretAccess, validateSecretPolicy, findPrivilegedProjectRoles } from './firebase-audit-schema.mjs';
import { validateProductionSigningKeyId } from './production-signing-schema.mjs';
import { validateProductionKeyVerifierWif } from './production-wif-schema.mjs';

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
const auditedResources = { functions: 0, gen1Functions: 0, gen2Functions: 0, functionIamPolicies: 0, runServices: 0, runIamPolicies: 0, protectedFlagVariables: 0 };
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
const functions = run(['functions', 'list', '--regions=-', '--project', project]);
const expectedProductionKid = process.env.PRODUCTION_RECOVERY_SIGNING_KEY_ID ?? '';
try { validateProductionSigningKeyId(functions, expectedProductionKid); }
catch (error) { problems.push(error.message); }
auditedResources.functions = functions.length;
if (!functions.length) problems.push('no production Cloud Functions found; runtime flags cannot be verified');
for (const f of functions) {
  const resource = `function ${f.name}`;
  const config = f.serviceConfig ?? f;
  inspectFunctionEnv(resource, config.environmentVariables ?? f.environmentVariables);
  inspectSecretFlag(resource, config.secretEnvironmentVariables ?? f.secretEnvironmentVariables);
  const functionName = String(f.name ?? '').split('/').pop();
  const nameParts = String(f.name ?? '').split('/');
  const locationIndex = nameParts.indexOf('locations');
  const functionRegion = locationIndex >= 0 ? nameParts[locationIndex + 1] : '';
  const generation = f.environment ?? (f.serviceConfig ? 'GEN_2' : 'GEN_1');
  if (!functionName || !functionRegion) {
    problems.push(`${resource}: function name or region is missing from the production inventory`);
  } else if (generation === 'GEN_1') {
    const policy = run(['functions', 'get-iam-policy', functionName, '--project', project, '--region', functionRegion]);
    auditedResources.gen1Functions++;
    auditedResources.functionIamPolicies++;
    if (hasPublicRuntimeInvoker(policy)) problems.push(`${resource}: first-generation function IAM grants public invocation`);
  } else if (generation === 'GEN_2') {
    // Gen2 invocation is enforced by its underlying Cloud Run service; that
    // service's IAM policy is checked in the complete Cloud Run inventory below.
    auditedResources.gen2Functions++;
  } else {
    problems.push(`${resource}: unknown Cloud Functions generation; invocation IAM cannot be audited`);
  }
}
const services = run(['run', 'services', 'list', '--project', project]);
auditedResources.runServices = services.length;
for (const functionName of findMissingGen2FunctionServices(functions, services)) {
  problems.push(`Gen2 function ${functionName} has no matching Cloud Run service in the same region`);
}
for (const service of services) {
  const serviceName = service.metadata?.name ?? service.name;
  const resource = `run service ${serviceName}`;
  const containers = service.spec?.template?.spec?.containers ?? service.template?.containers ?? [];
  for (const container of containers) {
    for (const entry of container.env ?? []) {
      if (!protectedFlagNames.has(entry.name)) continue;
      auditedResources.protectedFlagVariables++;
      if (entry.valueSource || entry.valueFrom) problems.push(`${resource}: ${entry.name} is secret-sourced and cannot be proven OFF`);
      else if (!off(entry.value)) problems.push(`${resource}: ${entry.name} is not OFF`);
    }
  }
  const serviceRegion = service.metadata?.labels?.['cloud.googleapis.com/location'];
  if (!serviceRegion || !serviceName) {
    problems.push(`${resource}: Cloud Run region is missing; service IAM could not be audited`);
  } else {
    const policy = run(['run', 'services', 'get-iam-policy', serviceName, '--region', serviceRegion, '--project', project]);
    auditedResources.runIamPolicies++;
    if (hasPublicRuntimeInvoker(policy)) problems.push(`${resource}: service-level IAM grants public invocation`);
  }
}
const verifier = process.env.ATTESTATION_VERIFIER_SERVICE;
const verifierCaller = process.env.ATTESTATION_VERIFIER_CALLER_SERVICE_ACCOUNT ?? '';
let verifierPolicy;
if (!verifier || !region) problems.push('ATTESTATION_VERIFIER_SERVICE and GCP_REGION must be configured');
else {
  verifierPolicy = run(['run', 'services', 'get-iam-policy', verifier, '--region', region, '--project', project]);
  if (hasPublicRuntimeInvoker(verifierPolicy)) problems.push('attestation verifier is publicly invokable');
}
const runtimeAccounts = list('RUNTIME_SERVICE_ACCOUNTS');
const auditServiceAccount = process.env.AUDIT_SERVICE_ACCOUNT ?? '';
const keyVerifierAccount = process.env.PRODUCTION_KEY_VERIFY_SERVICE_ACCOUNT ?? '';
const keyVerifierWifPrincipal = process.env.PRODUCTION_KEY_VERIFY_WIF_PRINCIPAL ?? '';
if (!runtimeAccounts.length) problems.push('RUNTIME_SERVICE_ACCOUNTS not configured');
if (!/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/.test(keyVerifierAccount)) {
  problems.push('PRODUCTION_KEY_VERIFY_SERVICE_ACCOUNT must be a valid service-account email');
}
const keyVerifierWifProvider = process.env.PRODUCTION_KEY_VERIFY_WIF_PROVIDER ?? '';
if (!keyVerifierWifProvider) {
  problems.push('PRODUCTION_KEY_VERIFY_WIF_PROVIDER is not configured');
} else {
  const projectInfo = run(['projects', 'describe', project]);
  const projectNumber = String(projectInfo.projectNumber ?? '');
  const providerParts = keyVerifierWifProvider.split('/');
  if (providerParts.length !== 8 || providerParts[0] !== 'projects' || providerParts[2] !== 'locations' ||
      providerParts[3] !== 'global' || providerParts[4] !== 'workloadIdentityPools' || providerParts[6] !== 'providers') {
    problems.push('PRODUCTION_KEY_VERIFY_WIF_PROVIDER must be a full production-project WIF provider resource name');
  } else {
    const poolId = providerParts[5], providerId = providerParts[7];
    const provider = run(['iam', 'workload-identity-pools', 'providers', 'describe', providerId,
      '--workload-identity-pool', poolId, '--location', 'global', '--project', project]);
    try {
      validateProductionKeyVerifierWif({
        projectNumber, providerResource: keyVerifierWifProvider, provider,
        principal: keyVerifierWifPrincipal,
      });
    } catch (error) { problems.push(error.message); }
  }
}
if (keyVerifierAccount && (runtimeAccounts.includes(keyVerifierAccount) || keyVerifierAccount === auditServiceAccount)) {
  problems.push('production signing-key verifier must be distinct from audit and runtime identities');
}
if (new Set(runtimeAccounts).size !== runtimeAccounts.length) problems.push('RUNTIME_SERVICE_ACCOUNTS contains duplicate identities');
if (!verifierCaller || !runtimeAccounts.includes(verifierCaller)) problems.push('ATTESTATION_VERIFIER_CALLER_SERVICE_ACCOUNT must be one of RUNTIME_SERVICE_ACCOUNTS');
if (verifierPolicy && !hasExactServiceInvoker(verifierPolicy, verifierCaller)) {
  problems.push('attestation verifier roles/run.invoker must be bound to exactly the configured Functions caller service account');
}
if (!auditServiceAccount) problems.push('AUDIT_SERVICE_ACCOUNT not configured');
if (auditServiceAccount && runtimeAccounts.includes(auditServiceAccount)) problems.push('audit identity must be distinct from every production runtime identity');
const requiredSecrets = list('REQUIRED_SECRETS');
const expectedRecoverySecrets = ['PHONE_PEPPER', 'RECOVERY_SIGNING_KEY_PKCS8'];
if (requiredSecrets.length !== expectedRecoverySecrets.length ||
    expectedRecoverySecrets.some(secret => !requiredSecrets.includes(secret))) {
  problems.push('REQUIRED_SECRETS must contain exactly PHONE_PEPPER and RECOVERY_SIGNING_KEY_PKCS8');
}
const secretPolicies = new Map();
const allowedSecretPrincipals = new Set([...runtimeAccounts, auditServiceAccount, keyVerifierAccount].filter(Boolean).map((account) => `serviceAccount:${account}`));
if (!requiredSecrets.length) problems.push('REQUIRED_SECRETS not configured');
for (const secret of requiredSecrets) {
  const versions = run(['secrets', 'versions', 'list', secret, '--project', project, '--filter=state=ENABLED']);
  if (!Array.isArray(versions) || versions.length === 0) problems.push(`secret ${secret}: no enabled version`);
  const policy = run(['secrets', 'get-iam-policy', secret, '--project', project]);
  secretPolicies.set(secret, policy);
  for (const issue of validateSecretPolicy(policy, allowedSecretPrincipals, runtimeAccounts, auditServiceAccount)) {
    problems.push(`secret ${secret}: ${issue}`);
  }
  const verifierMember = `serviceAccount:${keyVerifierAccount}`;
  const verifierBindings = (policy.bindings ?? []).filter(binding => (binding.members ?? []).includes(verifierMember));
  if (secret === 'PHONE_PEPPER' && verifierBindings.length) {
    problems.push('production signing-key verifier must not access PHONE_PEPPER');
  }
  if (secret === 'RECOVERY_SIGNING_KEY_PKCS8' &&
      (verifierBindings.length !== 1 || verifierBindings[0].role !== 'roles/secretmanager.secretAccessor')) {
    problems.push('production signing-key verifier must have only secretAccessor on RECOVERY_SIGNING_KEY_PKCS8');
  }
}
const allSecrets = run(['secrets', 'list', '--project', project]);
for (const secretResource of allSecrets) {
  const secretName = String(secretResource.name ?? '').split('/').pop();
  if (!secretName || requiredSecrets.includes(secretName)) continue;
  const policy = run(['secrets', 'get-iam-policy', secretName, '--project', project]);
  if ((policy.bindings ?? []).some(binding => (binding.members ?? []).includes(`serviceAccount:${keyVerifierAccount}`))) {
    problems.push(`production signing-key verifier has access to unexpected secret ${secretName}`);
  }
}
// Include every recovery callable, including those with no declared secrets.
 // Each callable must have its own runtime identity so an unbound callable cannot
 // inherit Secret Manager access from a sibling function.
const runtimeSecretBindings = {
  createRecoveryAttestationChallenge: [],
  verifyRecoveryDeviceAttestation: [],
  registerRecoveryPhone: ['PHONE_PEPPER'],
  exchangeOwnerEmailLink: [],
  confirmRecoveryOwnerBinding: [],
  registerRecoveryOwnerDevice: ['PHONE_PEPPER'],
  createRecoveryPasskeyEnrollmentOptions: [],
  completeRecoveryPasskeyEnrollment: [],
  retryRecoveryPasskeyEnrollmentAlert: [],
  getRecoveryOwnerPendingAction: [],
  getRecoveryOwnerActionReadiness: [],
  createRecoveryOwnerActionOptions: [],
  completeRecoveryOwnerPasskeyAction: [],
  acknowledgeRecoveryOwnerAlert: [],
  issueRecoveryGrant: ['PHONE_PEPPER', 'RECOVERY_SIGNING_KEY_PKCS8'],
  consumeRecoveryGrant: ['PHONE_PEPPER', 'RECOVERY_SIGNING_KEY_PKCS8'],
  cancelRecoveryRequest: [],
  cancelRecoveryPhoneChange: [],
  activateRecoveryPhoneChange: [],
};
const additionalSecretAccessors = new Map([['RECOVERY_SIGNING_KEY_PKCS8', new Set([`serviceAccount:${keyVerifierAccount}`])]]);
problems.push(...validateFunctionSecretAccess(functions, runtimeSecretBindings, secretPolicies, runtimeAccounts, requiredSecrets, additionalSecretAccessors));
const reviewedAccounts = [...new Set([...runtimeAccounts, auditServiceAccount, keyVerifierAccount].filter(Boolean))];
for (const account of reviewedAccounts) {
  const keys = run(['iam', 'service-accounts', 'keys', 'list', '--iam-account', account, '--managed-by=user', '--project', project]);
  if (keys.length) problems.push(`${account}: user-managed keys exist`);
  const policy = run(['iam', 'service-accounts', 'get-iam-policy', account, '--project', project]);
  if (account === keyVerifierAccount) {
    const wifBindings = (policy.bindings ?? []).filter(binding => binding.role === 'roles/iam.workloadIdentityUser');
    const wifMembers = wifBindings.flatMap(binding => binding.members ?? []);
    if (wifBindings.length !== 1 || wifMembers.length !== 1 || wifMembers[0] !== keyVerifierWifPrincipal ||
        (policy.bindings ?? []).length !== 1) {
      problems.push(`${account}: Workload Identity access must be limited to the configured GitHub principalSet`);
    }
  }
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
if ((projectPolicy.bindings ?? []).some(binding => (binding.members ?? []).includes(`serviceAccount:${keyVerifierAccount}`))) {
  problems.push('production signing-key verifier must have no project-level IAM bindings');
}
for (const risk of findProjectWideRecoveryRisks(projectPolicy)) {
  problems.push(`project-level ${risk.role} grant bypasses resource-scoped recovery IAM (${risk.memberCount} principal(s))`);
}
for (const account of reviewedAccounts) {
  for (const role of findPrivilegedProjectRoles(projectPolicy, account)) {
    problems.push(`${account}: project-level ${role}`);
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
const appCheckServices = [];
let appCheckPageToken;
const seenAppCheckPageTokens = new Set();
do {
  const appCheckUrl = new URL(`https://firebaseappcheck.googleapis.com/v1/projects/${encodeURIComponent(project)}/services`);
  appCheckUrl.searchParams.set('pageSize', '100');
  if (appCheckPageToken) appCheckUrl.searchParams.set('pageToken', appCheckPageToken);
  const appCheck = await fetch(appCheckUrl, {
    headers: { Authorization: `Bearer ${token}`, 'X-Goog-User-Project': project },
    signal: AbortSignal.timeout(15_000),
  });
  if (!appCheck.ok) fail(`App Check API returned ${appCheck.status}`);
  const payload = await appCheck.json();
  appCheckServices.push(...(payload.services ?? []));
  appCheckPageToken = payload.nextPageToken;
  if (appCheckPageToken && seenAppCheckPageTokens.has(appCheckPageToken)) fail('App Check API repeated a pagination token');
  if (appCheckPageToken) seenAppCheckPageTokens.add(appCheckPageToken);
} while (appCheckPageToken);
const modes = Object.fromEntries(appCheckServices.map((service) => [service.name.split('/').pop(), service.enforcementMode]));
for (const service of requiredAppCheckServices) if (modes[service] !== 'ENFORCED') problems.push(`App Check not ENFORCED for ${service}`);
fs.mkdirSync('evidence', { recursive: true });
fs.writeFileSync('evidence/production-audit.json', JSON.stringify({ project, checkedAt: new Date().toISOString(), productionRecoveryEnabled: problems.length === 0 ? false : null, recoverySigningKeyId: expectedProductionKid, auditedResources, firebaseAudit, problems }, null, 2));
if (problems.length) fail(problems.join('; '));
console.log('production audit clean: recovery OFF everywhere');
