import { PaymentProviderAdapter } from './adapter-contract.mjs';
import { decryptCCAvenue, encryptCCAvenue } from './ccavenue-crypto.mjs';

const BASE = Object.freeze({
  test: {
    checkout: 'https://test.ccavenue.com/transaction/transaction.do?command=initiateTransaction',
    api: 'https://apitest.ccavenue.com/apis/servlet/DoWebTrans'
  },
  live: {
    checkout: 'https://secure.ccavenue.com/transaction/transaction.do?command=initiateTransaction',
    api: 'https://api.ccavenue.com/apis/servlet/DoWebTrans'
  }
});
const validOrder = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,30}$/.test(value);
const minor = value => Number.isSafeInteger(value) && value > 0;
const toMinor = value => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const amount = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  return Number.isSafeInteger(amount) ? amount : null;
};
const money = value => (value / 100).toFixed(2);
const safeHttps = value => {
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
};

function parsePayload(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('ccavenue_response_empty');
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const out = {};
  for (const part of trimmed.split('&')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    out[decodeURIComponent(part.slice(0, index).replace(/\+/g, ' '))] =
      decodeURIComponent(part.slice(index + 1).replace(/\+/g, ' '));
  }
  return out;
}

export class CCAvenueAdapter extends PaymentProviderAdapter {
  constructor(options) {
    super(options);
    if (!['test', 'live'].includes(this.environment) ||
        !this.credentials.merchantId || !this.credentials.accessCode || !this.credentials.workingKey) {
      throw new TypeError('ccavenue_credentials_incomplete');
    }
    this.base = BASE[this.environment];
  }

  async api(command, request) {
    const body = new URLSearchParams({
      enc_request: encryptCCAvenue(JSON.stringify(request), this.credentials.workingKey),
      access_code: this.credentials.accessCode,
      command,
      request_type: 'JSON',
      response_type: 'JSON',
      version: '1.2'
    });
    const response = await this.fetch(this.base.api, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15000)
    });
    const text = await response.text();
    if (!response.ok) throw Object.assign(new Error('ccavenue_api_request_failed'), { providerStatus: response.status });
    const envelope = parsePayload(text);
    if (String(envelope.status) !== '0' || typeof envelope.enc_response !== 'string') {
      throw Object.assign(new Error('ccavenue_api_rejected'), {
        providerCode: String(envelope.enc_error_code || ''),
        providerMessage: String(envelope.enc_response || '').slice(0, 160)
      });
    }
    const decoded = parsePayload(decryptCCAvenue(envelope.enc_response, this.credentials.workingKey));
    if (String(decoded.status) !== '0') throw new Error('ccavenue_api_response_status_invalid');
    return decoded;
  }

  async validateCredentials() {
    // A non-existent, unique merchant order is a non-mutating authentication probe.
    // A valid "no record" response proves API authentication; it does not qualify UAT.
    const probe = 'AURCHK' + Date.now().toString(36).toUpperCase();
    try {
      await this.api('orderStatusTracker', { order_no: probe });
      return { valid: true, validation: 'authenticated_status_api' };
    } catch (error) {
      if (['51419', '51308', '51313'].includes(String(error.providerCode))) {
        return { valid: true, validation: 'authenticated_status_api_no_record' };
      }
      throw error;
    }
  }

  async createOrder(input) {
    if (!validOrder(input?.orderId) || !minor(input?.amountMinor) || input.currency !== 'INR' ||
        !safeHttps(input?.returnUrl) || !safeHttps(input?.cancelUrl || input?.returnUrl)) {
      throw new TypeError('invalid_ccavenue_order');
    }
    const fields = [
      ['merchant_id', this.credentials.merchantId],
      ['order_id', input.orderId],
      ['currency', 'INR'],
      ['amount', money(input.amountMinor)],
      ['redirect_url', input.returnUrl],
      ['cancel_url', input.cancelUrl || input.returnUrl],
      ['language', 'EN']
    ];
    const request = fields.map(([key, value]) => key + '=' + encodeURIComponent(value)).join('&');
    return {
      provider: 'ccavenue',
      orderId: input.orderId,
      amountMinor: input.amountMinor,
      currency: 'INR',
      status: 'PENDING',
      checkout: {
        action: this.base.checkout,
        method: 'POST',
        fields: {
          encRequest: encryptCCAvenue(request, this.credentials.workingKey),
          access_code: this.credentials.accessCode
        }
      }
    };
  }

  async findOrderByReference(input) {
    if (!validOrder(input?.reference)) throw new TypeError('invalid_ccavenue_order_reference');
    try {
      const result = await this.api('orderStatusTracker', { order_no: input.reference });
      const row = result.Order_Status_Result || result.order_status_result || result;
      if (String(row.order_no || '') !== input.reference) throw new Error('ccavenue_order_identity_mismatch');
      const amountMinor = toMinor(row.order_amt);
      return {
        found: true, orderId: input.reference, referenceNo: row.reference_no || null,
        amountMinor, currency: String(row.order_currncy || row.order_currency || ''),
        status: String(row.order_status || 'UNKNOWN')
      };
    } catch (error) {
      if (['51419', '51308', '51313'].includes(String(error.providerCode))) return { found: false };
      throw error;
    }
  }

  async getPaymentStatus(input) {
    const found = await this.findOrderByReference({ reference: input?.orderId });
    if (!found.found) return {
      provider: 'ccavenue', orderId: input.orderId, paymentId: null,
      paymentStatus: 'NOT_FOUND', amountMinor: null, currency: null, captured: false, found: false
    };
    const state = found.status.toLowerCase();
    const capturedMinor = toMinor(found.amountMinor == null ? null : money(found.amountMinor));
    const successful = ['successful', 'shipped'].includes(state);
    return {
      provider: 'ccavenue', orderId: found.orderId,
      paymentId: found.referenceNo, paymentStatus: found.status,
      amountMinor: capturedMinor, currency: found.currency,
      captured: successful && capturedMinor === input.expectedAmountMinor && found.currency === 'INR',
      found: true
    };
  }

  async verifyWebhook(rawBody) {
    if (!Buffer.isBuffer(rawBody) || !rawBody.length) return { valid: false };
    try {
      const params = new URLSearchParams(rawBody.toString('utf8'));
      const encrypted = params.get('encResp') || params.get('enc_response') || params.get('encresp');
      if (!encrypted) return { valid: false };
      const event = parsePayload(decryptCCAvenue(encrypted, this.credentials.workingKey));
      if (!validOrder(String(event.order_id || event.order_no || '')) ||
          String(event.merchant_id || '') !== String(this.credentials.merchantId)) return { valid: false };
      return { valid: true, event };
    } catch {
      return { valid: false };
    }
  }

  async createRefund() {
    // The published Merchant API v1.3 only documents splitRefund, which is
    // restricted to split-payout transactions and permits one refund only.
    // Do not misrepresent it as a general merchant refund API.
    throw Object.assign(new Error('ccavenue_general_refund_api_not_qualified'), {
      code: 'PROVIDER_REFUND_CONTRACT_UNAVAILABLE'
    });
  }

  async getRefundStatus() {
    throw Object.assign(new Error('ccavenue_general_refund_status_api_not_qualified'), {
      code: 'PROVIDER_REFUND_CONTRACT_UNAVAILABLE'
    });
  }
}
