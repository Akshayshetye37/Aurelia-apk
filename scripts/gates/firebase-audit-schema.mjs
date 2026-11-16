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
  return (policy?.bindings ?? []).some(binding =>
    binding.role === 'roles/run.invoker' &&
    (binding.members ?? []).some(member => member === 'allUsers' || member === 'allAuthenticatedUsers')
  );
}
