import crypto from 'node:crypto';
import { PaymentProviderAdapter } from './adapter-contract.mjs';

const BASE = Object.freeze({
  test: 'https://test.ccavenue.com',
  live: 'https://secure.ccavenue.com'
});
const API_BASE = Object.freeze({
  test: 'https://apitest.ccavenue.com/apis/servlet/DoWebTrans',
  live: 'https://api.ccavenue.com/apis/servlet/DoWebTrans'
});
const IV = Buffer.from(Array.from({ length: 16 }, (_, i) => i));
const id = value => typeof value === 'string' && /^[A-Za-z0-9_/-]{1,30}$/.test(value);
const minor = value => Number.isSafeInteger(value) && value > 0;
const amountText = value => (value / 100).toFixed(2);
const safeText = (value, max) => typeof value === 'string' && value.length <= max &&
  !/[&=\u0000-\u001f\u007f]/.test(value);

function keyFromWorkingKey(workingKey) {
  if (typeof workingKey !== 'string' || workingKey.length < 16 || workingKey.length > 128) {
    throw new TypeError('ccavenue_working_key_invalid');
  }
  return crypto.createHash('md5').update(workingKey, 'utf8').digest();
}

export function encryptCcaVenue(plainText, workingKey) {
  const cipher = crypto.createCipheriv('aes-128-cbc', keyFromWorkingKey(workingKey), IV);
  return Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]).toString('hex');
}

export function decryptCcaVenue(cipherHex, workingKey) {
  if (typeof cipherHex !== 'string' || !/^(?:[a-f0-9]{32})+$/i.test(cipherHex)) {
    throw new TypeError('ccavenue_ciphertext_invalid');
  }
  const decipher = crypto.createDecipheriv('aes-128-cbc', keyFromWorkingKey(workingKey), IV);
  return Buffer.concat([decipher.update(Buffer.from(cipherHex, 'hex')), decipher.final()]).toString('utf8');
}

function parsePairs(value) {
  const out = {};
  for (const part of String(value).split('&')) {
    if (!part) continue;
    const at = part.indexOf('=');
    if (at < 1) continue;
    const key = part.slice(0, at);
    const val = part.slice(at + 1);
    out[key] = val;
  }
  return out;
}

function extractFormBody(rawBody) {
  const text = rawBody.toString('utf8');
  const params = new URLSearchParams(text);
  const encResp = params.get('encResp') || params.get('enc_response');
  return encResp || ( /^[a-f0-9]+$/i.test(text.trim()) ? text.trim() : null );
}

function parseApiResponse(body, workingKey) {
  const params = new URLSearchParams(String(body));
  const status = params.get('status');
  const encrypted = params.get('enc_response');
  if (status === '1') throw Object.assign(new Error('ccavenue_api_rejected_request'), {
    providerCode: params.get('enc_error_code') || null,
    providerMessage: encrypted || 'CCAvenue API request failed'
  });
  if (status !== '0' || !encrypted) throw new Error('ccavenue_api_response_invalid');
  const plain = decryptCcaVenue(encrypted, workingKey);
  try { return JSON.parse(plain); }
  catch { throw new Error('ccavenue_api_payload_invalid'); }
}

export class CCAvenueAdapter extends PaymentProviderAdapter {
  constructor(options) {
    super(options);
    if (!['test', 'live'].includes(this.environment)) throw new TypeError('unsupported_environment');
    const c = this.credentials;
    if (!/^\d{1,12}$/.test(String(c.merchantId || '')) ||
        typeof c.accessCode !== 'string' || !/^[A-Za-z0-9]{8,64}$/.test(c.accessCode) ||
        typeof c.workingKey !== 'string' || c.workingKey.length < 16 || c.workingKey.length > 128) {
      throw new TypeError('ccavenue_credentials_incomplete');
    }
    this.baseUrl = BASE[this.environment];
    this.apiUrl = API_BASE[this.environment];
  }

  async apiRequest(command, payload) {
    const response = await this.fetch(this.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        enc_request: encryptCcaVenue(JSON.stringify(payload), this.credentials.workingKey),
        access_code: this.credentials.accessCode,
        command, request_type: 'JSON', response_type: 'JSON', version: '1.2'
      }),
      signal: AbortSignal.timeout(15000)
    });
    const body = await response.text();
    if (!response.ok) throw Object.assign(new Error('ccavenue_api_http_error'), { providerStatus: response.status });
    return parseApiResponse(body, this.credentials.workingKey);
  }

  async validateCredentials() {
    // CCAvenue requires the calling server's public IP to be allowlisted.
    // A deliberately non-existent order checks API authentication without
    // initiating a payment or changing merchant state.
    try {
      await this.apiRequest('orderStatusTracker', { order_no: 'AURELIA_CREDENTIAL_CHECK' });
    } catch (error) {
      if (!['51419', '51313', '51004'].includes(String(error.providerCode || ''))) throw error;
    }
    return { valid: true, remoteVerified: true, environment: this.environment };
  }

  async createOrder(input) {
    const orderId = input?.orderId || input?.receipt;
    if (!id(orderId) || !minor(input?.amountMinor) || input.currency !== 'INR' ||
        typeof input?.returnUrl !== 'string' || !input.returnUrl.startsWith('https://') ||
        typeof (input?.cancelUrl || input?.returnUrl) !== 'string' || !(input.cancelUrl || input.returnUrl).startsWith('https://')) {
      throw new TypeError('invalid_ccavenue_order');
    }
    const fields = [
      ['merchant_id', this.credentials.merchantId], ['order_id', orderId],
      ['currency', 'INR'], ['amount', amountText(input.amountMinor)],
      ['redirect_url', input.returnUrl], ['cancel_url', input.cancelUrl || input.returnUrl],
      ['language', 'EN']
    ];
    const customer = input.customer || {};
    if (safeText(customer.firstName, 60)) fields.push(['billing_name', customer.firstName]);
    if (safeText(customer.email, 70)) fields.push(['billing_email', customer.email]);
    if (typeof customer.phone === 'string' && /^\d{6,20}$/.test(customer.phone)) fields.push(['billing_tel', customer.phone]);
    const payload = fields.map(([key, value]) => key + '=' + value).join('&');
    const encRequest = encryptCcaVenue(payload, this.credentials.workingKey);
    return {
      provider: 'ccavenue', orderId, amountMinor: input.amountMinor, currency: 'INR',
      status: 'created',
      checkoutUrl: this.baseUrl + '/transaction/transaction.do?command=initiateTransaction',
      checkout: { method: 'POST', action: this.baseUrl + '/transaction/transaction.do?command=initiateTransaction',
        fields: { encRequest, access_code: this.credentials.accessCode } }
    };
  }

  async findOrderByReference(input) {
    const orderId = input?.reference || input?.orderId;
    if (!id(orderId)) throw new TypeError('invalid_ccavenue_order_reference');
    const result = await this.apiRequest('orderStatusTracker', { order_no: orderId });
    const row = result.Order_Status_Result || result.order_status_result || result;
    if (String(row.order_no || '') !== orderId) return { found: false };
    return { found: true, orderId, paymentId: String(row.reference_no || ''),
      amountMinor: Math.round(Number(row.order_amt) * 100), currency: row.order_currncy || row.order_currency || 'INR',
      status: row.order_status || 'Awaited', fraudStatus: row.order_fraud_status || null };
  }

  async getPaymentStatus(input) {
    const orderId = input?.orderId || input?.reference;
    if (!id(orderId)) throw new TypeError('invalid_ccavenue_order_reference');
    const result = await this.apiRequest('orderStatusTracker', {
      order_no: orderId, ...((input.referenceNo || input.paymentId) ? { reference_no: input.referenceNo || input.paymentId } : {})
    });
    const row = result.Order_Status_Result || result.order_status_result || result;
    if (String(row.order_no || '') !== orderId) throw new Error('ccavenue_order_identity_mismatch');
    const amountMinor = Math.round(Number(row.order_amt) * 100);
    const orderStatus = String(row.order_status || '').toLowerCase();
    return {
      provider: 'ccavenue', orderId, paymentId: row.reference_no ? String(row.reference_no) : null,
      paymentStatus: row.order_status || 'Awaited',
      amountMinor: Number.isSafeInteger(amountMinor) && amountMinor > 0 ? amountMinor : null,
      currency: row.order_currncy || row.order_currency || null,
      captured: ['successful', 'shipped'].includes(orderStatus) &&
        ['low', 'nr', 'ga', 'na'].includes(String(row.order_fraud_status || '').toLowerCase())
    };
  }

  async verifyWebhook(rawBody) {
    if (!Buffer.isBuffer(rawBody)) return { valid: false };
    try {
      const text = rawBody.toString('utf8').trim();
      if (text.startsWith('{')) {
        const event = JSON.parse(text);
        if (!event.order_id || !event.tracking_id || !event.order_status || !event.amount || !event.currency) return { valid: false };
        // Dynamic Event Notifications are an untrusted trigger; the server
        // always fetches the encrypted merchant Status API before capture.
        return { valid: true, event };
      }
      const encrypted = extractFormBody(rawBody);
      if (!encrypted) return { valid: false };
      const event = parsePairs(decryptCcaVenue(encrypted, this.credentials.workingKey));
      if (!event.order_id || !event.order_status || !event.amount || !event.currency) return { valid: false };
      return { valid: true, event };
    } catch { return { valid: false }; }
  }

  async createRefund(input) {
    // The published v1.3 API only documents splitRefund, which is restricted
    // to split-payout transactions and permits one refund. Do not misapply it
    // to ordinary gateway captures.
    if (input?.splitPayout !== true) throw new Error('ccavenue_standard_refund_requires_merchant_specific_api');
    if (!/^\d{1,25}$/.test(String(input.referenceNo || '')) ||
        !minor(input.amountMinor) || !/^[A-Za-z0-9]{1,30}$/.test(input.refundId || '')) {
      throw new TypeError('invalid_ccavenue_split_refund');
    }
    const result = await this.apiRequest('splitRefund', {
      reference_no: String(input.referenceNo),
      split_data_list: [{ refundAmount: amountText(input.amountMinor), refundRefNo: input.refundId }]
    });
    const row = result.split_refund_result || result;
    if (Number(row.refund_status) !== 0) throw new Error('ccavenue_split_refund_rejected');
    return { provider: 'ccavenue', refundId: input.refundId, status: 'submitted',
      amountMinor: input.amountMinor, currency: 'INR' };
  }

  async getRefundStatus() {
    throw new Error('ccavenue_refund_status_requires_merchant_specific_api');
  }
}
