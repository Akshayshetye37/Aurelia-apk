import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';

export function validateProductionSigningKeyId(functions, expectedKid) {
  if (!Array.isArray(functions) || !/^[A-Za-z0-9._-]{1,64}$/.test(expectedKid ?? '')) {
    throw new Error('PRODUCTION_RECOVERY_SIGNING_KEY_ID is missing or invalid');
  }
  const grantFunctions = functions.filter(fn =>
    ['issueRecoveryGrant', 'consumeRecoveryGrant'].includes(String(fn.name ?? '').split('/').pop()));
  const grantNames = grantFunctions.map(fn => String(fn.name ?? '').split('/').pop()).sort();
  const ids = grantFunctions.map(fn => (fn.serviceConfig ?? fn).environmentVariables?.RECOVERY_SIGNING_KEY_ID ??
    fn.environmentVariables?.RECOVERY_SIGNING_KEY_ID ?? '');
  if (JSON.stringify(grantNames) !== JSON.stringify(['consumeRecoveryGrant', 'issueRecoveryGrant']) ||
      ids.length !== 2 || ids.some(id => id !== expectedKid)) {
    throw new Error('production grant callables must expose the configured PRODUCTION_RECOVERY_SIGNING_KEY_ID');
  }
  return expectedKid;
}

export function verifyProductionSigningKeyPair(privateKeyPem, publicKeyRingInput, activeKid) {
  if (typeof privateKeyPem !== 'string' || !privateKeyPem.trim()) {
    throw new Error('production signing private key is missing');
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(activeKid ?? '')) {
    throw new Error('production signing key ID is invalid');
  }
  let publicKeyRing;
  try {
    publicKeyRing = typeof publicKeyRingInput === 'string' ? JSON.parse(publicKeyRingInput) : publicKeyRingInput;
  } catch {
    throw new Error('production public-key ring is invalid JSON');
  }
  const expected = publicKeyRing?.[activeKid];
  if (typeof expected !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(expected)) {
    throw new Error('active production public-key pin is missing or invalid');
  }
  let actual;
  try {
    const privateKey = createPrivateKey(privateKeyPem);
    actual = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64');
  } catch {
    throw new Error('production signing private key is not a valid PKCS#8 key');
  }
  if (actual !== expected) throw new Error('production APK public pin does not match the Secret Manager signing key');
  return {
    activeKid,
    publicKeySha256: createHash('sha256').update(Buffer.from(actual, 'base64')).digest('hex'),
  };
}
