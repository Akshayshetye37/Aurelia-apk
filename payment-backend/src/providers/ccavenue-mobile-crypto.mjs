import crypto from 'node:crypto';

const TRACKING_ID = /^[A-Za-z0-9]{1,20}$/;
const AMOUNT = /^(?:0|[1-9][0-9]{0,9})\.[0-9]{2}$/;

/**
 * Build the CCAvenue Mobile SDK requestHash on the trusted server.
 *
 * CCAvenue Mobile SDK Integration Guide v1.7 defines:
 * SHA512(tracking_id + currency + amount + working_key)
 *
 * The amount is deliberately accepted as a canonical decimal string. Do not
 * pass a JS Number or reformat an amount after the tracking ID was created:
 * the exact string must match the amount registered with CCAvenue.
 */
export function createCcaVenueRequestHash({ trackingId, currency, amount, workingKey }) {
  if (typeof trackingId !== 'string' || !TRACKING_ID.test(trackingId)) {
    throw new TypeError('ccavenue_tracking_id_invalid');
  }
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    throw new TypeError('ccavenue_currency_invalid');
  }
  if (typeof amount !== 'string' || !AMOUNT.test(amount)) {
    throw new TypeError('ccavenue_amount_must_be_canonical_decimal_string');
  }
  if (typeof workingKey !== 'string' || workingKey.length < 1 || workingKey.length > 256) {
    throw new TypeError('ccavenue_working_key_invalid');
  }

  return crypto.createHash('sha512')
    .update(trackingId + currency + amount + workingKey, 'utf8')
    .digest('hex');
}
