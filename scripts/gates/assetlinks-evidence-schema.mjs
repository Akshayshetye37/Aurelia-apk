const REQUIRED_RELATIONS = [
  'delegate_permission/common.handle_all_urls',
  'delegate_permission/common.get_login_creds',
].sort();
const fail = message => { throw new Error(message); };

export function validateAssetLinksEvidence(evidence, requiredFingerprint, now = Date.now()) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) fail('Digital Asset Links evidence is missing');
  if (typeof evidence.rpId !== 'string' || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$/.test(evidence.rpId) ||
      evidence.site !== `https://${evidence.rpId}` || evidence.packageName !== 'com.aurelia.pms') {
    fail('Digital Asset Links evidence has an invalid RP site or Android package');
  }
  const fingerprints = evidence.fingerprints;
  if (!Array.isArray(fingerprints) || fingerprints.length === 0 ||
      fingerprints.some(value => !/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(value)) ||
      new Set(fingerprints).size !== fingerprints.length) fail('Digital Asset Links certificate inventory is invalid');
  const required = String(requiredFingerprint ?? '').replace(/:/g, '').toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(required) || !fingerprints.includes(required.match(/.{2}/g).join(':'))) {
    fail('Digital Asset Links evidence does not include the required APK signer');
  }
  if (!Array.isArray(evidence.relations) || JSON.stringify(evidence.relations.slice().sort()) !== JSON.stringify(REQUIRED_RELATIONS)) {
    fail('Digital Asset Links evidence is missing a required Credential Manager relation');
  }
  if (!Array.isArray(evidence.apiChecks) || evidence.apiChecks.length !== fingerprints.length * REQUIRED_RELATIONS.length) {
    fail('Digital Asset Links Google API check matrix is incomplete');
  }
  for (const relation of REQUIRED_RELATIONS) {
    for (const fingerprint of fingerprints) {
      const match = evidence.apiChecks.filter(check => check.relation === relation && check.fingerprint === fingerprint && check.linked === true);
      if (match.length !== 1 || !/^\d+(?:\.\d+)?s$/.test(match[0].maxAge ?? '')) {
        fail(`Digital Asset Links Google API evidence is missing ${relation} / ${fingerprint}`);
      }
    }
  }
  const checkedAt = Date.parse(evidence.checkedAt ?? '');
  if (!Number.isFinite(checkedAt) || checkedAt > now + 300000 || now - checkedAt > 7 * 24 * 60 * 60 * 1000) {
    fail('Digital Asset Links evidence is missing, future-dated or older than seven days');
  }
  if (!Array.isArray(evidence.origins) || evidence.origins.length !== fingerprints.length ||
      evidence.origins.some(origin => !/^android:apk-key-hash:[A-Za-z0-9_-]{43}$/.test(origin))) {
    fail('Digital Asset Links Android origin pins are invalid');
  }
  return true;
}
