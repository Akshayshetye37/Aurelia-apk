const fail = message => { throw new Error(message); };

export const REQUIRED_DEVICE_RESULTS = Object.freeze({
  pinAFailsAfterRecovery: true,
  pinBOpensOriginalData: true,
  forceStopSurvived: true,
  rebootSurvived: true,
  replayRejected: true,
  lockScreenChangeFailsClosed: true,
  ownerCancelDuringHold: true,
  offlineNormalUse: true,
  logScanClean: true,
  notificationPermissionOffBlocksRecovery: true,
  ownerDeviceOfflineBlocksRecovery: true,
  noIndependentOwnerDeviceBlocksRecovery: true,
  simSwapRejected: true,
  hardwareBackedAttestationVerified: true,
  passkeyAssertionVerified: true,
});

/** Validate the one approved handset's complete manual-only qualification record. */
export function validateDeviceAttestation(attestation, expectedDevice = undefined) {
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) fail('device attestation must be an object');
  if (typeof attestation.deviceLabel !== 'string' || !/^[A-Z0-9-]{3,32}$/.test(attestation.deviceLabel)) {
    fail('deviceLabel must match the redacted Gate 4 device label');
  }
  if (typeof attestation.deviceModel !== 'string' || !attestation.deviceModel.trim() || attestation.deviceModel.length > 80 ||
      typeof attestation.androidVersion !== 'string' || !attestation.androidVersion.trim() || attestation.androidVersion.length > 40) {
    fail('device model and Android version are required');
  }
  if (!['StrongBox', 'TEE'].includes(attestation.hardwareSecurityLevel)) fail('hardwareSecurityLevel must be StrongBox or TEE');
  if (attestation.verifiedBoot !== 'green' || attestation.bootloaderLocked !== true) {
    fail('device must have verified boot green and a locked bootloader');
  }
  if (!/^[0-9a-f]{64}$/.test(attestation.dataChecksumBefore ?? '') ||
      attestation.dataChecksumBefore !== attestation.dataChecksumAfter) {
    fail('data checksums must be valid and match');
  }
  const results = attestation.results;
  if (!results || typeof results !== 'object' || Array.isArray(results)) fail('device results must be an object');
  const actualKeys = Object.keys(results).sort();
  const requiredKeys = Object.keys(REQUIRED_DEVICE_RESULTS).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(requiredKeys)) fail('device results must contain the exact complete physical qualification matrix');
  for (const [key, expected] of Object.entries(REQUIRED_DEVICE_RESULTS)) {
    if (results[key] !== expected) fail(`device result ${key} must be true`);
  }
  if (expectedDevice) {
    for (const key of ['deviceLabel', 'deviceModel', 'androidVersion']) {
      if (attestation[key] !== expectedDevice[key]) fail(`device attestation ${key} does not match Gate 4 evidence`);
    }
  }
  return true;
}
