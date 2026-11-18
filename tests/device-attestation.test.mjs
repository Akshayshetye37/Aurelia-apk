import test from 'node:test';
import assert from 'node:assert/strict';
import { REQUIRED_DEVICE_RESULTS, validateDeviceAttestation } from '../scripts/gates/device-attestation-schema.mjs';

const digest = 'a'.repeat(64);
const valid = () => ({
  kind: 'device',
  deviceLabel: 'AURELIA-PIXEL8',
  deviceModel: 'Pixel 8',
  androidVersion: '15',
  hardwareSecurityLevel: 'TEE',
  verifiedBoot: 'green',
  bootloaderLocked: true,
  dataChecksumBefore: digest,
  dataChecksumAfter: digest,
  results: { ...REQUIRED_DEVICE_RESULTS },
});

test('device attestation accepts a complete TEE-backed single-handset record', () => {
  assert.equal(validateDeviceAttestation(valid()), true);
});

test('device attestation accepts StrongBox and rejects missing/unknown hardware evidence', () => {
  assert.equal(validateDeviceAttestation({ ...valid(), hardwareSecurityLevel: 'StrongBox' }), true);
  for (const hardwareSecurityLevel of [undefined, 'software', 'unknown']) {
    assert.throws(() => validateDeviceAttestation({ ...valid(), hardwareSecurityLevel }), /hardwareSecurityLevel/);
  }
});

test('device attestation requires every manual negative-path test', () => {
  for (const key of Object.keys(REQUIRED_DEVICE_RESULTS)) {
    const payload = valid();
    delete payload.results[key];
    assert.throws(() => validateDeviceAttestation(payload), /exact complete physical qualification matrix/);
    const failed = valid();
    failed.results[key] = false;
    assert.throws(() => validateDeviceAttestation(failed), new RegExp(`device result ${key} must be true`));
  }
});

test('device attestation binds the manual record to the exact Gate 4 handset', () => {
  const payload = valid();
  assert.equal(validateDeviceAttestation(payload, payload), true);
  assert.throws(() => validateDeviceAttestation(payload, { ...payload, deviceLabel: 'OTHER-DEVICE' }), /does not match Gate 4 evidence/);
  assert.throws(() => validateDeviceAttestation({ ...payload, dataChecksumAfter: 'b'.repeat(64) }), /checksums must be valid and match/);
});
