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
