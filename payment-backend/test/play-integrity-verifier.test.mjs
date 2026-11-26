import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPlayIntegrityRequestHash, evaluatePlayIntegrityVerdict,
  decodeGooglePlayIntegrityToken
} from '../src/devices/play-integrity-verifier.mjs';

const context = {
  tenantId: 'tenant_123456', deviceId: 'device_123456',
  challengeId: 'challenge_123456', nonce: 'one-time-random-nonce'
};
const packageName = 'com.aurelia.pms';
const certificate = 'BASE64_SHA256_CERTIFICATE_DIGEST';
const requestHash = createPlayIntegrityRequestHash(context);
const now = 1_800_000_000_000;
const payload = (patch = {}) => ({
  requestDetails: {
    requestPackageName: packageName, requestHash,
    timestampMillis: String(now - 10_000)
  },
  appIntegrity: {
    packageName, appRecognitionVerdict: 'PLAY_RECOGNIZED',
    certificateSha256Digest: [certificate]
  },
  accountDetails: { appLicensingVerdict: 'LICENSED' },
  deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_BASIC_INTEGRITY', 'MEETS_DEVICE_INTEGRITY'] },
  ...patch
});

test('request hash is deterministic and bound to each enrollment dimension', () => {
  assert.equal(createPlayIntegrityRequestHash(context), requestHash);
  for (const field of Object.keys(context)) {
    assert.notEqual(createPlayIntegrityRequestHash({ ...context, [field]: context[field] + '_changed' }), requestHash);
  }
});

test('accepts a Google-decoded verdict only when request, app, license and device all match', () => {
  const result = evaluatePlayIntegrityVerdict({
    payload: payload(), expectedPackageName: packageName,
    expectedRequestHash: requestHash, allowedCertificateSha256Digests: [certificate], now
  });
  assert.equal(result.accepted, true);
  assert.equal(result.appRecognitionVerdict, 'PLAY_RECOGNIZED');
  assert.ok(result.deviceRecognitionVerdicts.includes('MEETS_DEVICE_INTEGRITY'));
});

test('rejects request replay, stale/future tokens, wrong package and request hash', () => {
  const cases = [
    [{ requestDetails: { ...payload().requestDetails, requestHash: 'other' } }, 'play_integrity_request_binding_mismatch'],
    [{ requestDetails: { ...payload().requestDetails, requestPackageName: 'other.package' } }, 'play_integrity_request_binding_mismatch'],
    [{ requestDetails: { ...payload().requestDetails, timestampMillis: String(now - 180_001) } }, 'play_integrity_token_timestamp_invalid'],
    [{ requestDetails: { ...payload().requestDetails, timestampMillis: String(now + 31_000) } }, 'play_integrity_token_timestamp_invalid'],
    [{ appIntegrity: { ...payload().appIntegrity, packageName: 'other.package' } }, 'play_integrity_app_not_recognized']
  ];
  for (const [patch, reason] of cases) {
    const result = evaluatePlayIntegrityVerdict({
      payload: payload(patch), expectedPackageName: packageName,
      expectedRequestHash: requestHash, allowedCertificateSha256Digests: [certificate], now
    });
    assert.equal(result.accepted, false);
    assert.equal(result.reason, reason);
  }
});

test('rejects unrecognized app, signing certificate, unlicensed app and compromised device', () => {
  const variants = [
    [{ appIntegrity: { ...payload().appIntegrity, appRecognitionVerdict: 'UNRECOGNIZED_VERSION' } }, 'play_integrity_app_not_recognized'],
    [{ appIntegrity: { ...payload().appIntegrity, certificateSha256Digest: ['wrong'] } }, 'play_integrity_signing_certificate_mismatch'],
    [{ accountDetails: { appLicensingVerdict: 'UNLICENSED' } }, 'play_integrity_app_not_licensed'],
    [{ deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_BASIC_INTEGRITY'] } }, 'play_integrity_device_integrity_not_met']
  ];
  for (const [patch, reason] of variants) {
    const result = evaluatePlayIntegrityVerdict({
      payload: payload(patch), expectedPackageName: packageName,
      expectedRequestHash: requestHash, allowedCertificateSha256Digests: [certificate], now
    });
    assert.equal(result.accepted, false);
    assert.equal(result.reason, reason);
  }
});

test('strong-integrity policy is explicit and optional', () => {
  const result = evaluatePlayIntegrityVerdict({
    payload: payload(), expectedPackageName: packageName,
    expectedRequestHash: requestHash, allowedCertificateSha256Digests: [certificate],
    now, requireStrongIntegrity: true
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'play_integrity_strong_integrity_required');
});

test('decode client authenticates to Google and never follows redirects', async () => {
  let request;
  const decoded = { requestDetails: { requestHash } };
  const result = await decodeGooglePlayIntegrityToken({
    packageName, integrityToken: 'x'.repeat(120),
    accessTokenProvider: async () => 'server-access-token',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ tokenPayloadExternal: decoded }) };
    }
  });
  assert.deepEqual(result, decoded);
  assert.match(request.url, /playintegrity\.googleapis\.com/);
  assert.equal(request.options.headers.Authorization, 'Bearer server-access-token');
  assert.equal(request.options.redirect, 'error');
  assert.deepEqual(JSON.parse(request.options.body), { integrityToken: 'x'.repeat(120) });
});

test('decode client rejects invalid credentials, malformed Google response and redirects', async () => {
  await assert.rejects(() => decodeGooglePlayIntegrityToken({
    packageName, integrityToken: 'x'.repeat(120),
    accessTokenProvider: async () => ''
  }), /access_token_unavailable/);
  await assert.rejects(() => decodeGooglePlayIntegrityToken({
    packageName, integrityToken: 'x'.repeat(120),
    accessTokenProvider: async () => 'token',
    fetchImpl: async () => ({ ok: true, json: async () => ({}) })
  }), /decode_response_invalid/);
  await assert.rejects(() => decodeGooglePlayIntegrityToken({
    packageName, integrityToken: 'x'.repeat(120),
    accessTokenProvider: async () => 'token',
    fetchImpl: async () => ({ ok: false })
  }), /decode_rejected/);
});
