import crypto from 'node:crypto';
import { PaymentProviderAdapter } from './adapter-contract.mjs';

// Confirm against Cashfree docs; override via options.apiVersion or credentials.apiVersion.
const DEFAULT_API_VERSION = '2025-01-01';
const REQUEST_TIMEOUT_MS = 15000;
const BASE = Object.freeze({ test: 'https://sandbox.cashfree.com/pg', live: 'https://api.cashfree.com/pg' });
const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
const orderId = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,45}$/.test(v);
const refundId = v => typeof v === 'string' && /^[A-Za-z0-9_-]{3,40}$/.test(v);
const minor = v => Number.isSafeInteger(v) && v > 0;
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const header = (headers, name) => {
  if (!plain(headers)) return undefined;
  const key = Object.keys(headers).find(k => k.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
};
const uuidFrom = value => {
  const bytes = crypto.createHash('sha256').update(String(value)).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = bytes.toString('hex');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
};
// String-based decimal parsing: no floating-point drift. Rejects >2 decimals and exponents.
const majorToMinor = value => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const s = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const n = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const cleanText = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(v);

export class CashfreeAdapter extends PaymentProviderAdapter {
  constructor(options) {
    super(options);
    if (!['test', 'live'].includes(this.environment)) throw new TypeError('unsupported_environment');
    const c = this.credentials || {};
    if (!c.appId || !c.secretKey) throw new TypeError('cashfree_credentials_incomplete');
    this.baseUrl = BASE[this.environment];
    this.apiVersion = options?.apiVersion || c.apiVersion || DEFAULT_API_VERSION;
    // Cashfree PG signs webhooks with the client secret key; a separate
    // webhookSecret is honoured only if explicitly configured.
    this.webhookKey = c.webhookSecret || c.secretKey;
  }

  // Errors carry `outcomeUnknown: true` when the provider may have processed the
  // request (timeout, network drop, 5xx). Reconcile before retrying.
  async request(method, path, body, requestId, idempotencyKey) {
    let response;
    try {
      response = await this.fetch(this.baseUrl + path, {
        method,
        headers: {
          'x-client-id': this.credentials.appId, 'x-client-secret': this.credentials.secretKey,
          'x-api-version': this.apiVersion, 'x-request-id': requestId || crypto.randomUUID(),
          ...(idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : {}),
          'Content-Type': 'application/json', Accept: 'application/json'
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch (cause) {
      throw Object.assign(new Error('cashfree_network_error'), { outcomeUnknown: true, cause });
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error('cashfree_request_failed'), {
        providerStatus: response.status,
        providerCode: typeof data?.code === 'string' ? data.code : undefined,
        outcomeUnknown: response.status >= 500
      });
    }
    return data;
  }

  // Cashfree PG has no reliable "list orders" call, so probe a nonexistent order:
  // 404 means the credentials authenticated; 401/403 means they did not.
  async validateCredentials() {
    try {
      await this.request('GET', '/orders/aurelia_credential_probe_' + crypto.randomBytes(6).toString('hex'));
      return { valid: true };
    } catch (e) {
      if (e.providerStatus === 404) return { valid: true };
      if (e.providerStatus === 401 || e.providerStatus === 403) return { valid: false };
      throw e;
    }
  }

  async createOrder(input) {
    let returnUrl;
    try { returnUrl = new URL(input?.returnUrl); } catch { returnUrl = null; }
    if (!orderId(input?.orderId) || !minor(input?.amountMinor) || input.currency !== 'INR' ||
        !id(input?.customer?.id) || typeof input?.customer?.phone !== 'string' ||
        !/^\+?\d{10,15}$/.test(input.customer.phone) ||
        (input.customer.email != null && typeof input.customer.email !== 'string') ||
        !returnUrl || returnUrl.protocol !== 'https:' || !id(input?.idempotencyKey)) {
      throw new TypeError('invalid_cashfree_order');
    }
    const data = await this.request('POST', '/orders', {
      order_id: input.orderId, order_amount: input.amountMinor / 100, order_currency: 'INR',
      customer_details: { customer_id: input.customer.id, customer_phone: input.customer.phone,
        ...(input.customer.email ? { customer_email: input.customer.email } : {}) },
      order_meta: { return_url: input.returnUrl }
    }, crypto.randomUUID(), uuidFrom(input.idempotencyKey));
    const amountMinor = majorToMinor(data.order_amount);
    if (data.order_id !== input.orderId || !data.payment_session_id ||
        amountMinor !== input.amountMinor || data.order_currency !== 'INR') {
      throw new Error('cashfree_checkout_response_binding_mismatch');
    }
    return { provider: 'cashfree', orderId: data.order_id, paymentSessionId: data.payment_session_id,
      checkoutUrl: data.payment_link || null, amountMinor, currency: data.order_currency,
      status: data.order_status };
  }

  async findOrderByReference(input) {
    if (!orderId(input?.reference)) throw new TypeError('invalid_cashfree_order_id');
    let order;
    try { order = await this.request('GET', '/orders/' + encodeURIComponent(input.reference)); }
    catch (e) { if (e.providerStatus === 404) return { found: false }; throw e; }
    if (order.order_id !== input.reference) return { found: false };
    return { found: true, orderId: order.order_id, amountMinor: majorToMinor(order.order_amount),
      currency: order.order_currency, status: order.order_status,
      paymentSessionId: order.payment_session_id || null, checkoutUrl: order.payment_link || null };
  }

  async getPaymentStatus(input) {
    if (!orderId(input?.orderId) || (input.paymentId != null && !id(String(input.paymentId)))) {
      throw new TypeError('invalid_cashfree_order_id');
    }
    const [order, payments] = await Promise.all([
      this.request('GET', '/orders/' + encodeURIComponent(input.orderId)),
      this.request('GET', '/orders/' + encodeURIComponent(input.orderId) + '/payments')
    ]);
    if (order.order_id !== input.orderId) throw new Error('cashfree_order_identity_mismatch');
    const list = Array.isArray(payments) ? payments : [];
    const matching = input.paymentId
      ? list.find(p => String(p.cf_payment_id) === String(input.paymentId))
      : list.find(p => p.payment_status === 'SUCCESS');
    const amountMinor = matching?.payment_amount == null ? null : majorToMinor(matching.payment_amount);
    const currency = matching?.payment_currency || null;
    const captured = matching?.payment_status === 'SUCCESS' && amountMinor !== null && currency === 'INR';
    if (matching && matching.order_id != null && matching.order_id !== input.orderId) {
      throw new Error('cashfree_payment_order_mismatch');
    }
    return { provider: 'cashfree', orderId: order.order_id, orderStatus: order.order_status,
      paymentId: matching?.cf_payment_id == null ? null : String(matching.cf_payment_id),
      paymentStatus: matching?.payment_status || (input.paymentId ? 'NOT_FOUND' : order.order_status),
      captured, amountMinor, currency };
  }

  async verifyWebhook(rawBody, headers) {
    const timestamp = header(headers, 'x-webhook-timestamp');
    const signature = header(headers, 'x-webhook-signature');
    if (!Buffer.isBuffer(rawBody) || typeof timestamp !== 'string' || !/^\d{10,16}$/.test(timestamp) ||
        typeof signature !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(signature)) return { valid: false };
    const n = Number(timestamp);
    const timestampMs = timestamp.length <= 10 ? n * 1000 : n;
    if (!Number.isSafeInteger(n) || Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000) return { valid: false };
    const expected = crypto.createHmac('sha256', this.webhookKey).update(timestamp).update(rawBody).digest('base64');
    const a = Buffer.from(signature), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { valid: false };
    try { return { valid: true, event: JSON.parse(rawBody.toString('utf8')) }; }
    catch { return { valid: false }; }
  }

  async createRefund(input) {
    const note = input?.reason == null ? 'Customer refund' : input.reason;
    const requestKey = input?.idempotencyKey == null ? input?.refundId : input.idempotencyKey;
    if (!orderId(input?.orderId) || !refundId(input?.refundId) || !minor(input?.amountMinor) ||
        !cleanText(requestKey, 1, 256) || !cleanText(note, 3, 100) ||
        (input.paymentId != null && !id(String(input.paymentId)))) {
      throw new TypeError('invalid_cashfree_refund');
    }
    const response = await this.request('POST', '/orders/' + encodeURIComponent(input.orderId) + '/refunds', {
      refund_id: input.refundId, refund_amount: input.amountMinor / 100, refund_note: note
    }, crypto.randomUUID(), uuidFrom(requestKey));
    const data = Array.isArray(response) ? (response.length === 1 ? response[0] : null) : response;
    if (!plain(data)) throw new Error('cashfree_refund_response_invalid');
    const amountMinor = majorToMinor(data.refund_amount);
    if (data.order_id !== input.orderId || data.refund_id !== input.refundId ||
        amountMinor !== input.amountMinor ||
        (input.paymentId && String(data.cf_payment_id) !== String(input.paymentId)) ||
        typeof data.refund_status !== 'string' || !data.refund_status ||
        (data.refund_currency && data.refund_currency !== 'INR')) {
      throw new Error('cashfree_refund_response_binding_mismatch');
    }
    return { provider: 'cashfree', refundId: data.refund_id,
      providerRefundId: data.cf_refund_id == null ? null : String(data.cf_refund_id),
      orderId: data.order_id, paymentId: data.cf_payment_id == null ? null : String(data.cf_payment_id),
      status: data.refund_status, amountMinor, currency: data.refund_currency || 'INR' };
  }

  async getRefundStatus(input) {
    if (!orderId(input?.orderId) || !refundId(input?.refundId) ||
        (input.paymentId != null && !id(String(input.paymentId)))) {
      throw new TypeError('invalid_cashfree_refund_lookup');
    }
    const refund = await this.request('GET', '/orders/' + encodeURIComponent(input.orderId) +
      '/refunds/' + encodeURIComponent(input.refundId));
    if (refund.refund_id !== input.refundId || refund.order_id !== input.orderId ||
        (input.paymentId && String(refund.cf_payment_id) !== String(input.paymentId))) {
      throw new Error('cashfree_refund_identity_mismatch');
    }
    const amountMinor = majorToMinor(refund.refund_amount);
    if (amountMinor === null || (refund.refund_currency && refund.refund_currency !== 'INR') ||
        typeof refund.refund_status !== 'string' || !refund.refund_status) {
      throw new Error('cashfree_refund_amount_or_currency_invalid');
    }
    return { provider: 'cashfree', refundId: refund.refund_id,
      providerRefundId: refund.cf_refund_id == null ? null : String(refund.cf_refund_id),
      orderId: refund.order_id, paymentId: refund.cf_payment_id == null ? null : String(refund.cf_payment_id),
      status: refund.refund_status, amountMinor, currency: refund.refund_currency || 'INR' };
  }
}