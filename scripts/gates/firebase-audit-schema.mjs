const fail = (message) => { throw new Error(message); };
const normalize = (values, length) => new Set((values ?? []).map(v => String(v).replaceAll(':','').toLowerCase()).filter(v => {
  if (!new RegExp(`^[0-9a-f]{${length}}$`).test(v)) fail('Firebase fingerprint allowlist contains an invalid hash'); return true;
}));
export function validateFirebaseFingerprintInventory(apps, fingerprintsByApp, expectedAppIds, allowedSha1, allowedSha256) {
  const ids = new Set(expectedAppIds), actual = new Map((apps ?? []).map(app => [app.appId, app]));
  if (!ids.size || actual.size !== ids.size || [...ids].some(id => !actual.has(id))) fail('Firebase Android app inventory does not exactly match FIREBASE_ANDROID_APP_IDS');
  const sha1 = normalize(allowedSha1,40), sha256 = normalize(allowedSha256,64);
  if (!sha1.size || !sha256.size) fail('both Firebase SHA-1 and SHA-256 allowlists must be configured');
  let n1=0,n256=0;
  for (const id of ids) {
    const app=actual.get(id);
    if (app.packageName!=='com.aurelia.pms' || (app.state && app.state!=='ACTIVE')) fail(`Firebase Android app ${id} has an unexpected package or state`);
    const certs=fingerprintsByApp[id];
    if (!Array.isArray(certs) || !certs.length) fail(`Firebase Android app ${id} has no registered signing fingerprints`);
    const a=new Set(certs.filter(x=>x.certType==='SHA_1').map(x=>String(x.shaHash??'').replaceAll(':','').toLowerCase()));
    const b=new Set(certs.filter(x=>x.certType==='SHA_256').map(x=>String(x.shaHash??'').replaceAll(':','').toLowerCase()));
    if (!a.size || !b.size || [...a].some(x=>!/^[0-9a-f]{40}$/.test(x)) || [...b].some(x=>!/^[0-9a-f]{64}$/.test(x))) fail(`Firebase Android app ${id} is missing a valid SHA-1 or SHA-256 fingerprint`);
    if (a.size!==sha1.size || [...a].some(x=>!sha1.has(x))) fail(`Firebase Android app ${id} SHA-1 inventory differs from the approved allowlist`);
    if (b.size!==sha256.size || [...b].some(x=>!sha256.has(x))) fail(`Firebase Android app ${id} SHA-256 inventory differs from the approved allowlist`);
    n1+=a.size; n256+=b.size;
  }
  return {androidApps:actual.size,sha1Fingerprints:n1,sha256Fingerprints:n256,sha256CertificateHashes:[...new Set([...ids].flatMap(id => (fingerprintsByApp[id] ?? []).filter(x => x.certType === 'SHA_256').map(x => String(x.shaHash).replaceAll(':','').toLowerCase())))].sort()};
}
export function countTestPhoneNumbers(value) {
  let count=0; const visit=node=>{ if(!node||typeof node!=='object') return; for(const [key,child] of Object.entries(node)) {
    if(key==='testPhoneNumbers' && child && typeof child==='object') count+=Array.isArray(child)?child.length:Object.keys(child).length; else visit(child);
  }}; visit(value); return count;
}

/** Build the documented Firebase Management API resource URL for an Android app's signing certificates. */
export function firebaseAndroidShaEndpoint(projectId, appId) {
  if (typeof projectId !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) fail('Firebase project ID is invalid');
  if (typeof appId !== 'string' || !/^[0-9]+:[0-9]+:android:[0-9a-f]+$/i.test(appId)) fail('Firebase Android app ID is invalid');
  return `https://firebase.googleapis.com/v1beta1/projects/${encodeURIComponent(projectId)}/androidApps/${encodeURIComponent(appId)}/sha`;
}

/** Validate the Gate 5 audit record and bind the release APK signer to Firebase production. */
export function isProductionAuditEvidenceValid(audit, expectedProjectId, releaseSignerSha256) {
  const firebase = audit?.firebaseAudit;
  return audit?.project === expectedProjectId &&
    Array.isArray(audit.problems) && audit.problems.length === 0 &&
    Number.isInteger(audit.auditedResources?.functions) && audit.auditedResources.functions > 0 &&
    Number.isInteger(audit.auditedResources?.runServices) && audit.auditedResources.runServices > 0 &&
    Number.isInteger(firebase?.androidApps) && firebase.androidApps > 0 &&
    Number.isInteger(firebase?.sha1Fingerprints) && firebase.sha1Fingerprints > 0 &&
    Number.isInteger(firebase?.sha256Fingerprints) && firebase.sha256Fingerprints > 0 &&
    Array.isArray(firebase?.sha256CertificateHashes) &&
    /^[0-9a-f]{64}$/.test(releaseSignerSha256 ?? '') &&
    firebase.sha256CertificateHashes.includes(releaseSignerSha256) &&
    firebase.projectTestPhoneNumbers === 0 &&
    firebase.tenantTestPhoneNumbers === 0 &&
    Number.isInteger(firebase.tenants) && firebase.tenants >= 0;
}

/** Detect inherited project-level public invocation grants for Cloud Run/Functions. */
export function hasPublicRuntimeInvoker(policy) {
  const invokerRoles = new Set(['roles/run.invoker', 'roles/cloudfunctions.invoker']);
  return (policy?.bindings ?? []).some(binding =>
    invokerRoles.has(binding.role) &&
    (binding.members ?? []).some(member => member === 'allUsers' || member === 'allAuthenticatedUsers')
  );
}

/** Enforce exact Secret Manager access for each production recovery callable. */
export function validateFunctionSecretAccess(functions, requiredBindings, secretPolicies, allowedRuntimeAccounts, requiredSecrets) {
  const problems = [];
  const byName = new Map((functions ?? []).map(fn => [String(fn.name ?? '').split('/').pop(), fn]));
  const expectedBySecret = new Map();
  const functionByRuntimeAccount = new Map();
  for (const [functionName, secrets] of Object.entries(requiredBindings ?? {})) {
    const fn = byName.get(functionName);
    if (!fn) { problems.push(`function ${functionName} is missing from production inventory`); continue; }
    const config = fn.serviceConfig ?? fn;
    const runtimeAccount = config.serviceAccountEmail ?? fn.serviceAccountEmail;
    if (!runtimeAccount) { problems.push(`function ${functionName} has no runtime service account`); continue; }
    if (!allowedRuntimeAccounts.includes(runtimeAccount)) problems.push(`function ${functionName} runtime identity is not in RUNTIME_SERVICE_ACCOUNTS`);
    const secretSet = [...new Set(secrets)].sort().join(',');
    const existing = functionByRuntimeAccount.get(runtimeAccount);
    if (existing && existing.secretSet !== secretSet) {
      problems.push(`functions ${existing.functions.join(', ')} and ${functionName} share runtime identity ${runtimeAccount} across different secret sets`);
      existing.functions.push(functionName);
    } else if (existing) {
      existing.functions.push(functionName);
    } else {
      functionByRuntimeAccount.set(runtimeAccount, { secretSet, functions: [functionName] });
    }
    for (const secret of secrets) {
      if (!requiredSecrets.includes(secret)) problems.push(`function ${functionName} uses undeclared REQUIRED_SECRETS entry ${secret}`);
      if (!expectedBySecret.has(secret)) expectedBySecret.set(secret, new Set());
      expectedBySecret.get(secret).add(`serviceAccount:${runtimeAccount}`);
    }
  }
  for (const secret of requiredSecrets ?? []) {
    const policy = secretPolicies.get(secret);
    if (!policy) { problems.push(`secret ${secret} has no readable IAM policy`); continue; }
    const actual = new Set((policy.bindings ?? [])
      .filter(binding => binding.role === 'roles/secretmanager.secretAccessor')
      .flatMap(binding => binding.members ?? [])
      .filter(member => member.startsWith('serviceAccount:')));
    const expected = expectedBySecret.get(secret) ?? new Set();
    if (actual.size !== expected.size || [...expected].some(member => !actual.has(member))) {
      problems.push(`secret ${secret} runtime accessor set differs from the declared function bindings`);
    }
  }
  return problems;
}

/** Restrict secret-level IAM to exact runtime accessor grants and no audit payload access. */
export function validateSecretPolicy(policy, allowedPrincipals, runtimeAccounts, auditServiceAccount) {
  const problems = [];
  for (const binding of policy?.bindings ?? []) {
    for (const member of binding.members ?? []) {
      if (!member.startsWith('serviceAccount:')) problems.push('non-service-account member');
      else if (!allowedPrincipals.has(member)) problems.push('unexpected service-account member');
      const runtime = runtimeAccounts.some(account => member === `serviceAccount:${account}`);
      if (runtime && binding.role !== 'roles/secretmanager.secretAccessor') problems.push(`runtime identity has unexpected role ${binding.role}`);
      if (auditServiceAccount && member === `serviceAccount:${auditServiceAccount}` &&
          ['roles/secretmanager.secretAccessor', 'roles/secretmanager.admin'].includes(binding.role)) {
        problems.push('audit identity has secret payload/admin access');
      }
    }
  }
  return problems;
}

const PRIVILEGED_PROJECT_ROLES = new Set([
  'roles/owner', 'roles/editor', 'roles/resourcemanager.projectIamAdmin',
  'roles/iam.securityAdmin', 'roles/iam.serviceAccountAdmin',
  'roles/iam.serviceAccountKeyAdmin', 'roles/iam.serviceAccountUser',
  'roles/iam.serviceAccountTokenCreator', 'roles/secretmanager.admin',
  'roles/secretmanager.secretAccessor', 'roles/run.admin', 'roles/run.invoker',
  'roles/cloudfunctions.admin', 'roles/cloudfunctions.invoker',
  'roles/firebase.admin', 'roles/firebaseauth.admin', 'roles/firebaseappcheck.admin',
]);
/** Return any project-level role that is too broad for a recovery runtime or audit identity. */
export function findPrivilegedProjectRoles(policy, account) {
  const principal = `serviceAccount:${account}`;
  return [...new Set((policy?.bindings ?? [])
    .filter(binding => PRIVILEGED_PROJECT_ROLES.has(binding.role) && (binding.members ?? []).includes(principal))
    .map(binding => binding.role))].sort();
}
