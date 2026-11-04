import crypto from 'node:crypto';
import { PaymentProviderAdapter } from './adapter-contract.mjs';

const ENVIRONMENTS = Object.freeze({
  test: {
    sale: 'https://uat.jiopay.co.in/tsp/pg/api/v2/initiateSale',
    command: 'https://uat.jiopay.co.in/tsp/pg/api/command'
  },
  live: {
    sale: 'https://jiopay.co.in/pg/api/v2/initiateSale',
    command: 'https://jiopay.co.in/pg/api/command'
  }
});
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const isHttpsUrl = value => {
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
};
const amount = value => Number.isSafeInteger(value) && value > 0;
const majorAmount = minor => (minor / 100).toFixed(2);
const asText = value => value == null ? '' : String(value);

function secureHash(fields, secret) {
  const message = Object.keys(fields).filter(key => key !== 'secureHash').sort()
    .map(key => asText(fields[key])).join('');
  return crypto.createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}
function safeEqualHex(actual, expected) {
  if (typeof actual !== 'string' || !/^[a-f0-9]{64}$/i.test(actual)) return false;
  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function verifiedPayload(payload, secret) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  return safeEqualHex(payload.secureHash, secureHash(payload, secret));
}
function statusName(code) {
  if (code === '0000') return 'success';
  if (typeof code === 'string' && /^(P|R)\d{4}$/.test(code)) return 'pending';
  return 'failed';
}

/**
 * Jio Payment Solutions Limited hosted-checkout adapter.
 * Implements the documented initiateSale + STATUS/REFUND command flow.
 * Merchant secret is supplied by the server-side Secret Manager only.
 */
export class JioPayAdapter extends PaymentProviderAdapter {
  constructor(options) {
    super(options);
    if (!ENVIRONMENTS[this.environment]) throw new TypeError('unsupported_environment');
    if (typeof this.credentials.merchantId !== 'string' || !this.credentials.merchantId ||
        typeof this.credentials.secretKey !== 'string' || !this.credentials.secretKey) {
      throw new TypeError('jiopay_credentials_incomplete');
    }
    this.endpoints = ENVIRONMENTS[this.environment];
    this.aggregatorId = this.credentials.aggregatorId || '';
    this.currencyCode = this.credentials.currencyCode || '356';
  }

  async postJson(url, payload) {
    const response = await this.fetch(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000)
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('jiopay_invalid_json_response'); }
    if (!response.ok) throw Object.assign(new Error('jiopay_request_failed'), { providerStatus: response.status });
    return data;
  }

  async postCommand(fields) {
    const payload = { ...fields, secureHash: secureHash(fields, this.credentials.secretKey) };
    const response = await this.fetch(this.endpoints.command, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(payload),
      signal: AbortSignal.timeout(15000)
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('jiopay_invalid_command_response'); }
    if (!response.ok) throw Object.assign(new Error('jiopay_command_failed'), { providerStatus: response.status });
    if (data && data.secureHash && !verifiedPayload(data, this.credentials.secretKey)) {
      throw new Error('jiopay_response_signature_invalid');
    }
    return data;
  }

  async validateCredentials() {
    // A STATUS query against a merchant-owned synthetic reference is not a credential
    // probe: it can create noisy audit events. Validate only configuration shape here.
    return { valid: true, environment: this.environment, merchantId: this.credentials.merchantId };
  }

  async createOrder(input) {
    if (!ID.test(input?.orderId || '') || !amount(input?.amountMinor) ||
        input.currency !== 'INR' || !isHttpsUrl(input?.returnUrl) ||
        typeof input?.customer?.email !== 'string' || !input.customer.email.includes('@')) {
      throw new TypeError('invalid_jiopay_order');
    }
    const fields = {
      amount: majorAmount(input.amountMinor),
      currencyCode: this.currencyCode,
      customerEmailID: input.customer.email,
      merchantId: this.credentials.merchantId,
      ...(this.aggregatorId ? { aggregatorID: this.aggregatorId } : {}),
      merchantTxnNo: input.orderId,
      payType: '0',
      returnURL: input.returnUrl,
      transactionType: 'SALE',
      txnDate: new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
    };
    const payload = { ...fields, secureHash: secureHash(fields, this.credentials.secretKey) };
    const result = await this.postJson(this.endpoints.sale, payload);
    if (!verifiedPayload(result, this.credentials.secretKey)) {
      throw new Error('jiopay_initiate_response_signature_invalid');
    }
    if (result.responseCode !== 'R1000' || !isHttpsUrl(result.redirectURI) ||
        result.merchantTxnNo !== input.orderId || result.merchantId !== this.credentials.merchantId ||
        typeof result.tranCtx !== 'string' || !result.tranCtx) {
      throw new Error('jiopay_checkout_session_rejected');
    }
    const redirect = new URL(result.redirectURI);
    redirect.searchParams.set('tranCtx', result.tranCtx);
    return {
      provider: 'jiopay',
      orderId: input.orderId,
      amountMinor: input.amountMinor,
      currency: 'INR',
      status: 'pending',
      redirectUrl: redirect.toString(),
      transactionContext: result.tranCtx
    };
  }

  async findOrderByReference(input) {
    if (!ID.test(input?.reference || '')) throw new TypeError('invalid_jiopay_reference');
    const status = await this.getPaymentStatus({ orderId: input.reference });
    return { found: status.paymentStatus !== 'not_found', orderId: input.reference,
      amountMinor: status.amountMinor, currency: 'INR', status: status.paymentStatus };
  }

  async getPaymentStatus(input) {
    if (!ID.test(input?.orderId || '')) throw new TypeError('invalid_jiopay_order_id');
    const fields = {
      merchantId: this.credentials.merchantId,
      ...(this.aggregatorId ? { aggregatorID: this.aggregatorId } : {}),
      merchantTxnNo: input.orderId,
      originalTxnNo: input.orderId,
      amount: '0',
      transactionType: 'STATUS'
    };
    const result = await this.postCommand(fields);
    if (result.merchantTxnNo && result.merchantTxnNo !== input.orderId) {
      throw new Error('jiopay_status_order_mismatch');
    }
    const state = statusName(result.responseCode);
    const amountMinor = typeof result.amount === 'string' && /^\d+(\.\d{1,2})?$/.test(result.amount)
      ? Math.round(Number(result.amount) * 100) : null;
    return {
      provider: 'jiopay', orderId: input.orderId,
      paymentId: result.paymentID || result.txnID || null,
      paymentStatus: state === 'success' ? 'SUCCESS' : state === 'pending' ? 'PENDING' : 'FAILED',
      captured: state === 'success', amountMinor, currency: 'INR',
      rawStatus: result.responseCode || null
    };
  }

  async verifyWebhook(rawBody, _headers = {}) {
    if (!Buffer.isBuffer(rawBody)) return { valid: false };
    let event;
    try { event = JSON.parse(rawBody.toString('utf8')); } catch { return { valid: false }; }
    if (!verifiedPayload(event, this.credentials.secretKey) ||
        event.merchantId !== this.credentials.merchantId ||
        typeof event.merchantTxnNo !== 'string' || !ID.test(event.merchantTxnNo)) return { valid: false };
    return { valid: true, event };
  }

  async createRefund(input) {
    if (!ID.test(input?.orderId || '') || !ID.test(input?.refundId || '') ||
        !amount(input?.amountMinor)) throw new TypeError('invalid_jiopay_refund');
    const fields = {
      merchantId: this.credentials.merchantId,
      ...(this.aggregatorId ? { aggregatorID: this.aggregatorId } : {}),
      merchantTxnNo: input.refundId,
      originalTxnNo: input.orderId,
      amount: majorAmount(input.amountMinor),
      transactionType: 'REFUND'
    };
    const result = await this.postCommand(fields);
    return {
      provider: 'jiopay',
      refundId: result.merchantTxnNo || input.refundId,
      providerRefundId: result.refundID || result.refundId || null,
      status: statusName(result.responseCode) === 'success' ? 'SUCCESS' :
        statusName(result.responseCode) === 'pending' ? 'PENDING' : 'FAILED',
      amountMinor: input.amountMinor,
      rawStatus: result.responseCode || null
    };
  }

  async getRefundStatus(input) {
    if (!ID.test(input?.orderId || '') || !ID.test(input?.refundId || '')) {
      throw new TypeError('invalid_jiopay_refund_reference');
    }
    const fields = {
      merchantId: this.credentials.merchantId,
      ...(this.aggregatorId ? { aggregatorID: this.aggregatorId } : {}),
      merchantTxnNo: input.refundId,
      originalTxnNo: input.orderId,
      amount: '0',
      transactionType: 'STATUS'
    };
    const result = await this.postCommand(fields);
    return {
      provider: 'jiopay',
      refundId: input.refundId,
      providerRefundId: result.refundID || result.refundId || null,
      status: statusName(result.responseCode) === 'success' ? 'SUCCESS' :
        statusName(result.responseCode) === 'pending' ? 'PENDING' : 'FAILED',
      rawStatus: result.responseCode || null
    };
  }
}
