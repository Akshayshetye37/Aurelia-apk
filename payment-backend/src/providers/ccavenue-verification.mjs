import { CCAvenueCrypto } from './ccavenue-crypto.mjs';

const ENDPOINTS = Object.freeze({
  test: 'https://apitest.ccavenue.com/apis/servlet/DoWebTrans',
  live: 'https://api.ccavenue.com/apis/servlet/DoWebTrans'
});
const ORDER_ID = /^[A-Za-z0-9_-]{1,30}$/;
const TRACKING_ID = /^[0-9]{1,25}$/;
const CURRENCY = /^[A-Z]{3}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,9})(?:\.([0-9]{1,2}))?$/;
const TIMEOUT_MS = 15000;
const RESPONSE_LIMIT = 128 * 1024;

function amountToMinor(value) {
  const raw = typeof value === 'number' && Number.isFinite(value)
    ? String(value) : typeof value === 'string' ? value.trim() : '';
  const match = DECIMAL.exec(raw);
  if (!match) throw new TypeError('ccavenue_api_amount_invalid');
  const minor = BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0') || '0');
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError('ccavenue_api_amount_out_of_range');
  return Number(minor);
}

function statusToPaymentState(value, fraudStatus) {
  if (String(fraudStatus || '').trim().toLowerCase() === 'high') return 'REVIEW';
  switch (String(value || '').trim().toLowerCase()) {
    case 'successful':
    case 'shipped': return 'CAPTURED';
    case 'unsuccessful':
    case 'aborted':
    case 'invalid':
    case 'cancelled':
    case 'auto-cancelled': return 'FAILED';
    case 'refunded': return 'REFUNDED';
    case 'system refund':
    case 'auto-reversed': return 'REVERSED';
    case 'chargeback': return 'DISPUTED';
    case 'fraud': return 'REVIEW';
    case 'awaited':
    case 'initiated': return 'PENDING';
    default: return 'UNKNOWN';
  }
}

function parseFormResponse(body) {
  if (typeof body !== 'string' || body.length < 1 || body.length > RESPONSE_LIMIT) {
    throw new Error('ccavenue_api_response_invalid');
  }
  const params = new URLSearchParams(body);
  const result = Object.create(null);
  for (const [key, value] of params.entries()) {
    if (!['status', 'enc_response', 'enc_error_code'].includes(key)) continue;
    if (Object.hasOwn(result, key)) throw new Error('ccavenue_api_duplicate_response_field');
    result[key] = value;
  }
  if (!['0', '1'].includes(result.status)) throw new Error('ccavenue_api_status_invalid');
  return result;
}

/**
 * Server-to-server CCAvenue Merchant API v1.3 orderStatusTracker.
 *
 * The guide's "v1.3" is the document revision. Its version request parameter
 * identifies the API protocol version; the published guide lists 1.1 as the
 * current parameter value. A merchant-issued newer API kit may override it.
 */
export class CCAvenueVerificationService {
  constructor({ encryptionKey, accessCode, environment, apiVersion = '1.1',
    fetchImpl = fetch, timeoutMs = TIMEOUT_MS }) {
    if (!['test', 'live'].includes(environment)) throw new TypeError('ccavenue_environment_invalid');
    if (typeof accessCode !== 'string' || !/^[A-Za-z0-9]{8,64}$/.test(accessCode)) {
      throw new TypeError('ccavenue_access_code_invalid');
    }
    if (apiVersion !== '1.1') throw new TypeError('ccavenue_api_version_invalid');
    if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1000 || timeoutMs > 60000) throw new TypeError('ccavenue_transport_config_invalid');
    this.crypto = new CCAvenueCrypto(encryptionKey);
    this.accessCode = accessCode;
    this.environment = environment;
    this.apiVersion = apiVersion;
    this.endpoint = ENDPOINTS[environment];
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async verifyOrderStatus({ orderId, trackingId, expectedAmountMinor, expectedCurrency = 'INR' }) {
    if (typeof orderId !== 'string' || !ORDER_ID.test(orderId) ||
        (trackingId != null && (typeof trackingId !== 'string' || !TRACKING_ID.test(trackingId))) ||
        (trackingId == null && !orderId) ||
        !Number.isSafeInteger(expectedAmountMinor) || expectedAmountMinor <= 0 ||
        typeof expectedCurrency !== 'string' || !CURRENCY.test(expectedCurrency)) {
      throw new TypeError('ccavenue_status_lookup_binding_invalid');
    }

    const query = { order_no: orderId, ...(trackingId ? { reference_no: trackingId } : {}) };
    const form = new URLSearchParams({
      enc_request: this.crypto.encrypt(JSON.stringify(query)),
      access_code: this.accessCode,
      command: 'orderStatusTracker',
      request_type: 'JSON',
      response_type: 'JSON',
      version: this.apiVersion
    });

    let response;
    try {
      response = await this.fetch(this.endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (cause) {
      throw Object.assign(new Error('ccavenue_status_transport_error'), { outcomeUnknown: true, cause });
    }

    const responseText = await response.text().catch(() => '');
    if (!response.ok) {
      throw Object.assign(new Error('ccavenue_status_http_error'), {
        providerStatus: response.status,
        outcomeUnknown: response.status >= 500
      });
    }

    const envelope = parseFormResponse(responseText);
    if (envelope.status === '1') {
      throw Object.assign(new Error('ccavenue_status_api_rejected'), {
        providerError: envelope.enc_response || 'unknown_provider_error',
        providerErrorCode: envelope.enc_error_code || null
      });
    }
    if (!envelope.enc_response) throw new Error('ccavenue_status_response_missing');

    let payload;
    try {
      payload = JSON.parse(this.crypto.decrypt(envelope.enc_response.trim()));
    } catch (cause) {
      throw Object.assign(new Error('ccavenue_status_response_decode_failed'), { cause });
    }
    const result = payload?.Order_Status_Result && typeof payload.Order_Status_Result === 'object'
      ? payload.Order_Status_Result : payload;
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error('ccavenue_status_result_missing');
    }

    const returnedOrderId = result.order_no;
    const returnedTrackingId = result.reference_no;
    if (returnedOrderId !== orderId) throw new Error('ccavenue_status_order_mismatch');
    if (trackingId && returnedTrackingId !== trackingId) {
      throw new Error('ccavenue_status_tracking_mismatch');
    }
    if (result.status !== 0 && result.status !== '0') {
      throw new Error('ccavenue_status_result_not_successful');
    }
    const currency = result.order_currncy;
    if (currency !== expectedCurrency) throw new Error('ccavenue_status_currency_mismatch');
    const amountMinor = amountToMinor(result.order_amt);
    if (amountMinor !== expectedAmountMinor) throw new Error('ccavenue_status_amount_mismatch');

    const providerStatus = typeof result.order_status === 'string' ? result.order_status.trim() : '';
    if (!providerStatus) throw new Error('ccavenue_status_order_state_missing');
    if (result.status !== 0 && result.status !== '0') {
      throw new Error('ccavenue_status_result_not_successful');
    }
    const captureAmountMinor = result.order_capt_amt == null
      ? null : amountToMinor(result.order_capt_amt);
    if (captureAmountMinor != null && captureAmountMinor > amountMinor) {
      throw new Error('ccavenue_status_capture_amount_exceeds_order');
    }
    const fraudStatus = typeof result.order_fraud_status === 'string' ? result.order_fraud_status : null;
    let paymentStatus = statusToPaymentState(providerStatus, fraudStatus);
    if (paymentStatus === 'CAPTURED' && captureAmountMinor != null && captureAmountMinor > 0 &&
        captureAmountMinor < amountMinor) paymentStatus = 'PARTIALLY_CAPTURED';
    return Object.freeze({
      provider: 'ccavenue',
      orderId: returnedOrderId,
      trackingId: returnedTrackingId || null,
      paymentStatus,
      providerStatus,
      amountMinor,
      currency,
      bankReference: typeof result.order_bank_ref_no === 'string' ? result.order_bank_ref_no : null,
      fraudStatus,
      capturedAmountMinor: captureAmountMinor,
      verified: true,
      evidenceSource: 'ccavenue_order_status_tracker'
    });
  }
}
