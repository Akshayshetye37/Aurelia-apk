import crypto from 'node:crypto';
import { PaymentProviderAdapter } from './adapter-contract.mjs';

const API_VERSION = '2026-01-01';
const BASE = Object.freeze({ test: 'https://sandbox.cashfree.com/pg', live: 'https://api.cashfree.com/pg' });
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const minor = value => Number.isSafeInteger(value) && value > 0;
const refundId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{3,40}$/.test(value);
const uuidFrom = value => {
  const bytes = crypto.createHash('sha256').update(String(value)).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
    hex.slice(16, 20) + '-' + hex.slice(20);
};
const majorToMinor = value => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^[0-9]+(?:\.[0-9]{1,2})?$/.test(value.trim())) return null;
  const major = Number(value);
  const scaled = major * 100;
  if (!Number.isFinite(major) || major <= 0 || !Number.isSafeInteger(Math.round(scaled)) ||
      Math.abs(scaled - Math.round(scaled)) > 1e-7) return null;
  return Math.round(scaled);
};

export class CashfreeAdapter extends PaymentProviderAdapter {
  constructor(options) {
    super(options);
    if (!['test', 'live'].includes(this.environment)) throw new TypeError('unsupported_environment');
    if (!this.credentials.appId || !this.credentials.secretKey || !this.credentials.webhookSecret) {
      throw new TypeError('cashfree_credentials_incomplete');
    }
    this.baseUrl = BASE[this.environment];
  }

  async request(method, path, body, requestId, idempotencyKey) {
    const response = await this.fetch(this.baseUrl + path, {
      method,
      headers: {
        'x-client-id': this.credentials.appId, 'x-client-secret': this.credentials.secretKey,
        'x-api-version': API_VERSION, 'x-request-id': requestId || crypto.randomUUID(),
        ...(idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : {}),
        'Content-Type': 'application/json', Accept: 'application/json'
      },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error('cashfree_request_failed'), {
      providerStatus: response.status, providerCode: typeof data.code === 'string' ? data.code : undefined
    });
    return data;
  }

  async validateCredentials() {
    await this.request('GET', '/orders?limit=1');
    return { valid: true };
  }

  async createOrder(input) {
    if (!id(input?.orderId) || !minor(input?.amountMinor) || input.currency !== 'INR' ||
        !id(input?.customer?.id) || typeof input?.customer?.phone !== 'string' ||
        typeof input?.returnUrl !== 'string' || !input.returnUrl.startsWith('https://') ||
        !id(input?.idempotencyKey)) throw new TypeError('invalid_cashfree_order');
    const idempotencyUuid = uuidFrom(input.idempotencyKey);
    const data = await this.request('POST', '/orders', {
      order_id: input.orderId, order_amount: input.amountMinor / 100, order_currency: 'INR',
      customer_details: { customer_id: input.customer.id, customer_phone: input.customer.phone,
        ...(input.customer.email ? { customer_email: input.customer.email } : {}) },
      order_meta: { return_url: input.returnUrl }
    }, crypto.randomUUID(), idempotencyUuid);
    const amountMinor = majorToMinor(data.order_amount);
    if (!data.order_id || data.order_id !== input.orderId || !data.payment_session_id ||
        amountMinor !== input.amountMinor || data.order_currency !== 'INR') {
      throw new Error('cashfree_checkout_response_binding_mismatch');
    }
    return { provider: 'cashfree', orderId: data.order_id, paymentSessionId: data.payment_session_id,
      checkoutUrl: data.payment_link || null, amountMinor,
      currency: data.order_currency, status: data.order_status };
  }

  async findOrderByReference(input) {
    if (!id(input?.reference)) throw new TypeError('invalid_cashfree_order_id');
    const order = await this.request('GET', '/orders/' + encodeURIComponent(input.reference));
    return { found: order.order_id === input.reference, orderId: order.order_id,
      amountMinor: majorToMinor(order.order_amount), currency: order.order_currency,
      status: order.order_status, paymentSessionId: order.payment_session_id || null,
      checkoutUrl: order.payment_link || null };
  }

  async getPaymentStatus(input) {
    if (!id(input?.orderId)) throw new TypeError('invalid_cashfree_order_id');
    const [order, payments] = await Promise.all([
      this.request('GET', '/orders/' + encodeURIComponent(input.orderId)),
      this.request('GET', '/orders/' + encodeURIComponent(input.orderId) + '/payments')
    ]);
    const matching = Array.isArray(payments)
      ? (input.paymentId ? payments.find(p => String(p.cf_payment_id) === String(input.paymentId))
        : payments.find(p => p.payment_status === 'SUCCESS')) : null;
    const paymentAmount = matching?.payment_amount;
    const amountMinor = paymentAmount == null ? null : majorToMinor(paymentAmount);
    const currency = matching?.payment_currency || null;
    return { provider: 'cashfree', orderId: order.order_id, orderStatus: order.order_status,
      paymentId: matching?.cf_payment_id == null ? null : String(matching.cf_payment_id),
      paymentStatus: matching?.payment_status || order.order_status,
      captured: matching?.payment_status === 'SUCCESS' && Number.isSafeInteger(amountMinor) && amountMinor > 0 && currency === 'INR',
      amountMinor: Number.isSafeInteger(amountMinor) && amountMinor > 0 ? amountMinor : null,
      currency };
  }

  async verifyWebhook(rawBody, headers) {
    const timestamp = headers['x-webhook-timestamp'] || headers['X-Webhook-Timestamp'];
    const signature = headers['x-webhook-signature'] || headers['X-Webhook-Signature'];
    if (typeof timestamp !== 'string' || !/^\d{10,16}$/.test(timestamp) ||
        typeof signature !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(signature) || !Buffer.isBuffer(rawBody)) return { valid: false };
    const timestampNumber = Number(timestamp);
    const timestampMs = timestamp.length <= 10 ? timestampNumber * 1000 : timestampNumber;
    if (!Number.isSafeInteger(timestampNumber) || !Number.isFinite(timestampMs) ||
        Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000) return { valid: false };
    const expected = crypto.createHmac('sha256', this.credentials.webhookSecret).update(timestamp).update(rawBody).digest('base64');
    const a = Buffer.from(signature), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { valid: false };
    try { return { valid: true, event: JSON.parse(rawBody.toString('utf8')) }; }
    catch { return { valid: false }; }
  }

  async createRefund(input) {
    const note = input?.reason == null ? 'Customer refund' : input.reason;
    if (!id(input?.orderId) || !refundId(input?.refundId) || !minor(input?.amountMinor) ||
        typeof note !== 'string' || note.length < 3 || note.length > 100 ||
        /[\u0000-\u001f\u007f]/.test(note)) {
      throw new TypeError('invalid_cashfree_refund');
    }
    const response = await this.request('POST', '/orders/' + encodeURIComponent(input.orderId) + '/refunds', {
      refund_id: input.refundId, refund_amount: input.amountMinor / 100,
      refund_note: note
    }, crypto.randomUUID(), uuidFrom(input.idempotencyKey || input.refundId));
    const data = Array.isArray(response) && response.length === 1 ? response[0]
      : (!Array.isArray(response) ? response : null);
    if (!data || typeof data !== 'object') throw new Error('cashfree_refund_response_invalid');
    const amountMinor = majorToMinor(data.refund_amount);
    if (data.order_id !== input.orderId || data.refund_id !== input.refundId ||
        !Number.isSafeInteger(amountMinor) || amountMinor !== input.amountMinor ||
        (input.paymentId && String(data.cf_payment_id) !== String(input.paymentId)) ||
        typeof data.refund_status !== 'string' || !data.refund_status ||
        (data.refund_currency && data.refund_currency !== 'INR')) {
      throw new Error('cashfree_refund_response_binding_mismatch');
    }
    return {
      provider: 'cashfree',
      refundId: data.refund_id,
      providerRefundId: data.cf_refund_id == null ? null : String(data.cf_refund_id),
      orderId: data.order_id,
      paymentId: data.cf_payment_id == null ? null : String(data.cf_payment_id),
      status: data.refund_status,
      amountMinor,
      currency: data.refund_currency || 'INR'
    };
  }

  async getRefundStatus(input) {
    if (!id(input?.orderId) || !refundId(input?.refundId)) throw new TypeError('invalid_cashfree_refund_lookup');
    const refund = await this.request('GET', '/orders/' + encodeURIComponent(input.orderId) +
      '/refunds/' + encodeURIComponent(input.refundId));
    if (refund.refund_id !== input.refundId || refund.order_id !== input.orderId ||
        (input.paymentId && String(refund.cf_payment_id) !== String(input.paymentId))) {
      throw new Error('cashfree_refund_identity_mismatch');
    }
    const amountMinor = majorToMinor(refund.refund_amount);
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 ||
        (refund.refund_currency && refund.refund_currency !== 'INR')) {
      throw new Error('cashfree_refund_amount_or_currency_invalid');
    }
    return {
      provider: 'cashfree',
      refundId: refund.refund_id,
      providerRefundId: refund.cf_refund_id == null ? null : String(refund.cf_refund_id),
      orderId: refund.order_id,
      paymentId: refund.cf_payment_id == null ? null : String(refund.cf_payment_id),
      status: refund.refund_status,
      amountMinor,
      currency: refund.refund_currency || 'INR'
    };
  }
}
