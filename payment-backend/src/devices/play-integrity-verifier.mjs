import crypto from 'node:crypto';

const sha256Base64Url = value => crypto.createHash('sha256').update(value).digest('base64url');
const DEFAULT_MAX_AGE_MS = 2 * 60 * 1000;
const DEFAULT_FUTURE_SKEW_MS = 30 * 1000;

export function createPlayIntegrityRequestHash({ tenantId, deviceId, challengeId, nonce }) {
  for (const [field, value] of Object.entries({ tenantId, deviceId, challengeId, nonce })) {
    if (typeof value !== 'string' || !value || value.length > 512) {
      throw new TypeError('invalid_play_integrity_' + field);
    }
  }
  // Bind the attestation to this tenant, enrolled device and one-time server
  // challenge. Do not include raw secrets or PII in the Play requestHash.
  return sha256Base64Url([
    'AURELIA_PLAY_INTEGRITY_ENROLLMENT_V1',
    tenantId, deviceId, challengeId, sha256Base64Url(nonce)
  ].join('\n'));
}

/**
 * Validate the decoded Google Play Integrity verdict.
 * The caller MUST obtain tokenPayloadExternal from Google's authenticated
 * decodeIntegrityToken API; this function never decodes an untrusted JWT.
 */
export function evaluatePlayIntegrityVerdict({
  payload, expectedPackageName, expectedRequestHash,
  allowedCertificateSha256Digests, now = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS, futureSkewMs = DEFAULT_FUTURE_SKEW_MS,
  requireStrongIntegrity = false
}) {
  const reject = reason => ({ accepted: false, reason });
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      typeof expectedPackageName !== 'string' || !expectedPackageName ||
      typeof expectedRequestHash !== 'string' || !expectedRequestHash ||
      !Array.isArray(allowedCertificateSha256Digests) || !allowedCertificateSha256Digests.length ||
      !Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    return reject('play_integrity_verification_context_invalid');
  }

  const request = payload.requestDetails;
  if (!request || request.requestPackageName !== expectedPackageName ||
      request.requestHash !== expectedRequestHash) {
    return reject('play_integrity_request_binding_mismatch');
  }
  const timestamp = Number(request.timestampMillis);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 ||
      timestamp > now + futureSkewMs || now - timestamp > maxAgeMs) {
    return reject('play_integrity_token_timestamp_invalid');
  }

  const app = payload.appIntegrity;
  if (!app || app.packageName !== expectedPackageName ||
      app.appRecognitionVerdict !== 'PLAY_RECOGNIZED') {
    return reject('play_integrity_app_not_recognized');
  }
  const certs = app.certificateSha256Digest;
  if (!Array.isArray(certs) || !certs.some(value =>
    typeof value === 'string' && allowedCertificateSha256Digests.includes(value))) {
    return reject('play_integrity_signing_certificate_mismatch');
  }

  if (payload.accountDetails?.appLicensingVerdict !== 'LICENSED') {
    return reject('play_integrity_app_not_licensed');
  }

  const deviceVerdicts = payload.deviceIntegrity?.deviceRecognitionVerdict;
  if (!Array.isArray(deviceVerdicts) || !deviceVerdicts.includes('MEETS_DEVICE_INTEGRITY')) {
    return reject('play_integrity_device_integrity_not_met');
  }
  if (requireStrongIntegrity && !deviceVerdicts.includes('MEETS_STRONG_INTEGRITY')) {
    return reject('play_integrity_strong_integrity_required');
  }

  return Object.freeze({
    accepted: true,
    packageName: app.packageName,
    appRecognitionVerdict: app.appRecognitionVerdict,
    appLicensingVerdict: payload.accountDetails.appLicensingVerdict,
    deviceRecognitionVerdicts: Object.freeze([...deviceVerdicts]),
    certificateSha256Digest: Object.freeze([...certs]),
    timestampMillis: timestamp,
    requestHash: request.requestHash
  });
}

/** Server-to-server token decode. OAuth access token must have playintegrity scope. */
export async function decodeGooglePlayIntegrityToken({
  packageName, integrityToken, accessTokenProvider,
  fetchImpl = globalThis.fetch
}) {
  if (typeof packageName !== 'string' || !/^[A-Za-z0-9_.]+$/.test(packageName) ||
      typeof integrityToken !== 'string' || integrityToken.length < 100 ||
      integrityToken.length > 20_000 || typeof accessTokenProvider !== 'function' ||
      typeof fetchImpl !== 'function') {
    throw new TypeError('invalid_play_integrity_decode_request');
  }
  const accessToken = await accessTokenProvider();
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new Error('play_integrity_access_token_unavailable');
  }
  const response = await fetchImpl(
    'https://playintegrity.googleapis.com/v1/' + encodeURIComponent(packageName) + ':decodeIntegrityToken',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ integrityToken }),
      redirect: 'error',
      signal: AbortSignal.timeout(8_000)
    }
  );
  if (!response.ok) throw new Error('google_play_integrity_decode_rejected');
  const decoded = await response.json();
  if (!decoded || typeof decoded !== 'object' ||
      !decoded.tokenPayloadExternal || typeof decoded.tokenPayloadExternal !== 'object') {
    throw new Error('google_play_integrity_decode_response_invalid');
  }
  return decoded.tokenPayloadExternal;
}
