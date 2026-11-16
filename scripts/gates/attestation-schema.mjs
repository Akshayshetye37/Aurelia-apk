const fail = (message) => { throw new Error(message); };
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validateSmsAttestation(attestation, now = Date.now()) {
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) fail('SMS attestation must be an object');
  const delivered = Date.parse(attestation.smsDeliveredAt), tested = Date.parse(attestation.testedAt);
  if (!Number.isFinite(delivered) || !Number.isFinite(tested)) fail('smsDeliveredAt and testedAt must be valid ISO timestamps');
  if (delivered > tested || tested > now + 300000 || now - tested > 7 * 864e5) fail('SMS delivery/test timestamps are out of order, future-dated or stale');
  if (tested - delivered > 15 * 60000) fail('SMS delivery timestamp must be within 15 minutes of the test');
  if (typeof attestation.challengeId !== 'string' || !UUID_V4.test(attestation.challengeId)) fail('challengeId must be a UUID v4 correlation ID');
  if (typeof attestation.deviceLabel !== 'string' || !/^[A-Za-z][A-Za-z0-9 ._-]{1,47} Android [0-9]{1,2}(?:\\.[0-9]{1,2})?$/.test(attestation.deviceLabel)) fail('deviceLabel must be a redacted, non-serial device label');
  if (typeof attestation.deviceIdentitySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(attestation.deviceIdentitySha256)) fail('deviceIdentitySha256 must be a SHA-256 hash of the redacted device identity');
  return true;
}
