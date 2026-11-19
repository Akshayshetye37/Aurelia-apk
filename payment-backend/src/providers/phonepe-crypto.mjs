import crypto from 'node:crypto';

export function encodePhonePePayload(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

export function generatePhonePeXVerify({ payloadBase64, apiPath, saltKey, saltIndex }) {
  if (typeof payloadBase64 !== 'string' || !payloadBase64 ||
      typeof apiPath !== 'string' || !apiPath.startsWith('/') ||
      typeof saltKey !== 'string' || !saltKey ||
      (typeof saltIndex !== 'string' && typeof saltIndex !== 'number')) {
    throw new TypeError('invalid_phonepe_signature_input');
  }
  const digest = crypto.createHash('sha256')
    .update(payloadBase64 + apiPath + saltKey, 'utf8').digest('hex');
  return digest + '###' + String(saltIndex);
}

export function generatePhonePeStatusXVerify({ apiPath, saltKey, saltIndex }) {
  if (typeof apiPath !== 'string' || !apiPath.startsWith('/') ||
      typeof saltKey !== 'string' || !saltKey ||
      (typeof saltIndex !== 'string' && typeof saltIndex !== 'number')) {
    throw new TypeError('invalid_phonepe_signature_input');
  }
  const digest = crypto.createHash('sha256').update(apiPath + saltKey, 'utf8').digest('hex');
  return digest + '###' + String(saltIndex);
}
