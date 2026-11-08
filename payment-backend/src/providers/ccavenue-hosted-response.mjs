/**
 * Parse and bind the classic CCAvenue hosted-checkout return payload.
 *
 * This module deliberately does not decrypt encResp and does not establish a
 * successful payment. It validates the plaintext response only after a
 * separately verified CCAvenue codec has decrypted it. A successful-looking
 * browser return is a reconciliation hint; the Merchant API status lookup
 * must independently confirm the payment before Aurelia fulfils an order.
 */

const TRACKING_ID = /^[0-9]{1,12}$/;
const ORDER_ID = /^[A-Za-z0-9_-]{1,50}$/;
const CURRENCY = /^[A-Z]{3}$/;
const AMOUNT = /^(?:0|[1-9][0-9]{0,9})\\.[0-9]{2}$/;
const ALLOWED_FIELDS = new Set([
  'order_id', 'tracking_id', 'bank_ref_no', 'order_status',
  'failure_message', 'payment_mode', 'status_code', 'status_message',
  'currency', 'Amount'
]);

function parseMinorUnits(value) {
  if (typeof value !== 'string' || !AMOUNT.test(value)) {
    throw new TypeError('ccavenue_response_amount_invalid');
  }
  const [whole, fraction] = value.split('.');
  const minor = Number(whole) * 100 + Number(fraction);
  if (!Number.isSafeInteger(minor) || minor < 0) {
    throw new TypeError('ccavenue_response_amount_out_of_range');
  }
  return minor;
}

/**
 * @param {string|URLSearchParams|Record<string,string>} plaintext
 * @param {{orderId:string, amountMinor:number, currency:string}} expected
 * @returns {{provider:string, orderId:string, trackingId:string,
 *   bankReference:string|null, providerStatus:string, candidateStatus:string,
 *   amountMinor:number, currency:string, paymentMode:string|null,
 *   failureMessage:string|null, statusCode:string|null, statusMessage:string|null,
 *   verified:false}}
 */
export function parseCcaVenueHostedResponse(plaintext, expected) {
  if (!expected || typeof expected.orderId !== 'string' ||
      !ORDER_ID.test(expected.orderId) ||
      !Number.isSafeInteger(expected.amountMinor) || expected.amountMinor <= 0 ||
      typeof expected.currency !== 'string' || !CURRENCY.test(expected.currency)) {
    throw new TypeError('ccavenue_expected_payment_binding_invalid');
  }

  let entries;
  if (typeof plaintext === 'string') {
    if (plaintext.length < 1 || plaintext.length > 16384) {
      throw new TypeError('ccavenue_response_payload_invalid');
    }
    const params = new URLSearchParams(plaintext);
    entries = [...params.entries()];
  } else if (plaintext instanceof URLSearchParams) {
    entries = [...plaintext.entries()];
  } else if (plaintext && typeof plaintext === 'object' && !Array.isArray(plaintext)) {
    entries = Object.entries(plaintext);
    if (entries.some(([, value]) => typeof value !== 'string')) {
      throw new TypeError('ccavenue_response_payload_invalid');
    }
  } else {
    throw new TypeError('ccavenue_response_payload_invalid');
  }

  const data = Object.create(null);
  for (const [key, value] of entries) {
    if (!ALLOWED_FIELDS.has(key)) continue;
    if (Object.hasOwn(data, key)) throw new TypeError('ccavenue_response_duplicate_field');
    if (typeof value !== 'string' || value.length > 2048) {
      throw new TypeError('ccavenue_response_field_invalid');
    }
    data[key] = value;
  }

  if (!ORDER_ID.test(data.order_id || '') || data.order_id !== expected.orderId) {
    throw new Error('ccavenue_response_order_mismatch');
  }
  if (!TRACKING_ID.test(data.tracking_id || '')) {
    throw new TypeError('ccavenue_response_tracking_id_invalid');
  }
  if (data.currency !== expected.currency || !CURRENCY.test(data.currency || '')) {
    throw new Error('ccavenue_response_currency_mismatch');
  }
  const amountMinor = parseMinorUnits(data.Amount);
  if (amountMinor !== expected.amountMinor) {
    throw new Error('ccavenue_response_amount_mismatch');
  }

  const status = data.order_status;
  if (!['Success', 'Failure', 'Aborted', 'Invalid', 'Timeout'].includes(status)) {
    throw new TypeError('ccavenue_response_order_status_invalid');
  }

  const candidateStatus = status === 'Success' ? 'success_candidate'
    : status === 'Failure' || status === 'Invalid' ? 'failure_candidate'
      : status === 'Aborted' ? 'aborted_candidate' : 'unknown_candidate';

  return Object.freeze({
    provider: 'ccavenue',
    orderId: data.order_id,
    trackingId: data.tracking_id,
    bankReference: data.bank_ref_no || null,
    providerStatus: status,
    candidateStatus,
    amountMinor,
    currency: data.currency,
    paymentMode: data.payment_mode || null,
    failureMessage: data.failure_message || null,
    statusCode: data.status_code || null,
    statusMessage: data.status_message || null,
    verified: false
  });
}
