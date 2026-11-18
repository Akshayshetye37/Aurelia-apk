export function isManualAttestationFresh(attestation, now = Date.now(), maxAgeMs = 7 * 864e5) {
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) return false;
  const testedAt = Date.parse(attestation.testedAt ?? '');
  return Number.isFinite(testedAt) && testedAt <= now + 3e5 && now - testedAt <= maxAgeMs;
}
