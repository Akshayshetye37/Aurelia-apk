const fail = (message) => { throw new Error(message); };
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Validate privacy-safe evidence for a real Firebase Phone Auth SMS challenge. */
export function validateSmsAttestation(attestation, now = Date.now()) {
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) fail('SMS attestation must be an object');
  const delivered = Date.parse(attestation.smsDeliveredAt);
  const tested = Date.parse(attestation.testedAt);
  if (!Number.isFinite(delivered) || !Number.isFinite(tested)) fail('smsDeliveredAt and testedAt must be valid ISO timestamps');
  if (delivered > tested || tested > now + 300_000 || now - tested > 7 * 864e5) fail('SMS delivery/test timestamps are out of order, future-dated or stale');
  if (tested - delivered > 15 * 60_000) fail('SMS delivery timestamp must be within 15 minutes of the test');
  if (typeof attestation.challengeId !== 'string' || !UUID_V4.test(attestation.challengeId)) fail('challengeId must be a UUID v4 correlation ID');
  if (typeof attestation.deviceLabel !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{1,63}$/.test(attestation.deviceLabel)) fail('deviceLabel must be a redacted, non-serial device label');
  if (typeof attestation.deviceIdentitySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(attestation.deviceIdentitySha256)) fail('deviceIdentitySha256 must be a SHA-256 hash of the redacted device identity');
  return true;
}

const normalizeFingerprints = (values, length) => new Set((values ?? []).map((value) => String(value).replaceAll(':', '').toLowerCase()).filter((value) => {
  if (!new RegExp(`^[0-9a-f]{${length}}$`).test(value)) fail('Firebase fingerprint allowlist contains an invalid hash');
  return true;
}));

/** Require an exact Firebase Android app and signing-certificate inventory. */
export function validateFirebaseFingerprintInventory(apps, fingerprintsByApp, expectedAppIds, allowedSha1, allowedSha256) {
  const expectedIds = new Set(expectedAppIds);
  const actualApps = new Map((apps ?? []).map((app) => [app.appId, app]));
  if (!expectedIds.size || actualApps.size !== expectedIds.size || [...expectedIds].some((id) => !actualApps.has(id))) fail('Firebase Android app inventory does not exactly match FIREBASE_ANDROID_APP_IDS');
  const expected1 = normalizeFingerprints(allowedSha1, 40);
  const expected256 = normalizeFingerprints(allowedSha256, 64);
  if (!expected1.size || !expected256.size) fail('both Firebase SHA-1 and SHA-256 allowlists must be configured');
  let sha1Count = 0, sha256Count = 0;
  for (const appId of expectedIds) {
    const app = actualApps.get(appId);
    if (app.packageName !== 'com.aurelia.pms' || app.state && app.state !== 'ACTIVE') fail(`Firebase Android app ${appId} has an unexpected package or state`);
    const certificates = fingerprintsByApp[appId];
    if (!Array.isArray(certificates) || !certificates.length) fail(`Firebase Android app ${appId} has no registered signing fingerprints`);
    const actual1 = new Set(certificates.filter((item) => item.certType === 'SHA_1').map((item) => String(item.shaHash ?? '').replaceAll(':', '').toLowerCase()));
    const actual256 = new Set(certificates.filter((item) => item.certType === 'SHA_256').map((item) => String(item.shaHash ?? '').replaceAll(':', '').toLowerCase()));
    if (!actual1.size || !actual256.size || [...actual1].some((hash) => !/^[0-9a-f]{40}$/.test(hash)) || [...actual256].some((hash) => !/^[0-9a-f]{64}$/.test(hash))) fail(`Firebase Android app ${appId} is missing a valid SHA-1 or SHA-256 fingerprint`);
    if (actual1.size !== expected1.size || [...actual1].some((hash) => !expected1.has(hash))) fail(`Firebase Android app ${appId} SHA-1 inventory differs from the approved allowlist`);
    if (actual256.size !== expected256.size || [...actual256].some((hash) => !expected256.has(hash))) fail(`Firebase Android app ${appId} SHA-256 inventory differs from the approved allowlist`);
    sha1Count += actual1.size; sha256Count += actual256.size;
  }
  return { androidApps: actualApps.size, sha1Fingerprints: sha1Count, sha256Fingerprints: sha256Count };
}

/** Count test-number entries without ever returning or persisting the numbers/codes. */
export function countTestPhoneNumbers(value) {
  let count = 0;
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if (key === 'testPhoneNumbers' && child && typeof child === 'object') {
        count += Array.isArray(child) ? child.length : Object.keys(child).length;
      } else visit(child);
    }
  };
  visit(value);
  return count;
}
