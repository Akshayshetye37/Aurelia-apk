import crypto from 'node:crypto';
import { PaymentProviderAdapter } from './adapter-contract.mjs';

const REQUEST_TIMEOUT_MS = 15000;
const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
// Razorpay limits order receipts to 40 characters.
const receipt = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v);
const minor = v => Number.isSafeInteger(v) && v > 0;
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
// Razorpay notes: max 15 pairs, each value <= 256 chars.
const notesOk = (n, max) => plain(n) && Object.keys(n).length <= max &&
  Object.entries(n).every(([k, x]) => typeof k === 'string' && k.length > 0 && k.length <= 256 &&
    ['string', 'number', 'boolean'].includes(typeof x) && String(x).length <= 256);
const header = (headers, name) => {
  if (!plain(headers)) return undefined;
  const key = Object.keys(headers).find(k => k.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
};

export class RazorpayAdapter extends PaymentProviderAdapter {
  constructor(options) {
    super(options);
    if (!['test', 'live'].includes(this.environment)) throw new TypeError('unsupported_environment');
    const c = this.credentials || {};
    if (!c.keyId || !c.keySecret || !c.webhookSecret) throw new TypeError('razorpay_credentials_incomplete');
    if ((this.environment === 'test') !== c.keyId.startsWith('rzp_test_') ||
        (this.environment === 'live') !== c.keyId.startsWith('rzp_live_')) {
      throw new TypeError('razorpay_key_environment_mismatch');
    }
    this.baseUrl = 'https://api.razorpay.com/v1';
  }

  // Errors carry `outcomeUnknown: true` when the provider may have processed the
  // request (timeout, network drop, 5xx). Callers must reconcile before retrying.
  async request(method, path, body, extraHeaders = {}) {
    let response;
    try {
      response = await this.fetch(this.baseUrl + path, {
        method,
        headers: {
          Authorization: 'Basic ' + Buffer.from(this.credentials.keyId + ':' + this.credentials.keySecret).toString('base64'),
          'Content-Type': 'application/json', Accept: 'application/json', ...extraHeaders
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch (cause) {
      throw Object.assign(new Error('razorpay_network_error'), { outcomeUnknown: true, cause });
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error('razorpay_request_failed'), {
        providerStatus: response.status,
        providerCode: typeof data?.error?.code === 'string' ? data.error.code : undefined,
        outcomeUnknown: response.status >= 500
      });
    }
    return data;
  }

  async validateCredentials() {
    await this.request('GET', '/orders?count=1');
    return { valid: true };
  }

  async createOrder(input) {
    if (!minor(input?.amountMinor) || input.currency !== 'INR' || !receipt(input?.receipt) ||
        (input.notes != null && !notesOk(input.notes, 15))) {
      throw new TypeError('invalid_razorpay_order');
    }
    const order = await this.request('POST', '/orders', {
      amount: input.amountMinor, currency: 'INR', receipt: input.receipt,
      ...(input.notes ? { notes: input.notes } : {})
    });
    if (!id(order?.id) || order.amount !== input.amountMinor || order.currency !== 'INR' ||
        order.receipt !== input.receipt) {
      throw new Error('razorpay_order_response_binding_mismatch');
    }
    return { provider: 'razorpay', orderId: order.id, amountMinor: order.amount,
      currency: order.currency, status: order.status, keyId: this.credentials.keyId };
  }

  async findOrderByReference(input) {
    if (!receipt(input?.reference)) throw new TypeError('invalid_razorpay_receipt');
    const data = await this.request('GET', '/orders?receipt=' + encodeURIComponent(input.reference) + '&count=100');
    const matches = Array.isArray(data.items) ? data.items.filter(o => o.receipt === input.reference) : [];
    if (matches.length !== 1) return { found: false, ambiguous: matches.length > 1 };
    const order = matches[0];
    return { found: true, orderId: order.id, amountMinor: order.amount,
      currency: order.currency, receipt: order.receipt, status: order.status };
  }

  async getPaymentStatus(input) {
    const hasPay = input?.paymentId != null, hasOrder = input?.orderId != null;
    if ((hasPay && !id(input.paymentId)) || (hasOrder && !id(input.orderId)) || (!hasPay && !hasOrder)) {
      throw new TypeError('invalid_razorpay_payment_lookup');
    }
    const path = hasPay ? '/payments/' + encodeURIComponent(input.paymentId)
      : '/orders/' + encodeURIComponent(input.orderId) + '/payments';
    const data = await this.request('GET', path);
    let payment = null;
    if (Array.isArray(data.items)) {
      const sorted = [...data.items].sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));
      // Prefer a captured payment, then authorized, so a newer failed retry cannot mask success.
      payment = hasPay ? sorted.find(p => p.id === input.paymentId)
        : (sorted.find(p => p.captured === true) || sorted.find(p => p.status === 'authorized') || sorted[0] || null);
    } else if (hasPay) {
      payment = data.id === input.paymentId ? data : null;
    }
    if (!payment) {
      return { provider: 'razorpay', orderId: input.orderId ?? null, paymentId: null,
        paymentStatus: 'pending', captured: false };
    }
    if (hasOrder && payment.order_id != null && payment.order_id !== input.orderId) throw new Error('razorpay_payment_order_mismatch');
    return { provider: 'razorpay', orderId: payment.order_id || null, paymentId: payment.id,
      paymentStatus: payment.status, amountMinor: payment.amount, currency: payment.currency,
      captured: payment.captured === true && minor(payment.amount) && payment.currency === 'INR' };
  }

  async verifyWebhook(rawBody, headers) {
    const signature = header(headers, 'x-razorpay-signature');
    if (!Buffer.isBuffer(rawBody) || typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) {
      return { valid: false };
    }
    const expected = crypto.createHmac('sha256', this.credentials.webhookSecret).update(rawBody).digest();
    const received = Buffer.from(signature, 'hex');
    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return { valid: false };
    try {
      const eventId = header(headers, 'x-razorpay-event-id');
      return { valid: true, event: JSON.parse(rawBody.toString('utf8')),
        ...(typeof eventId === 'string' ? { eventId } : {}) };
    } catch { return { valid: false }; }
  }

  async createRefund(input) {
    const notes = input?.notes == null ? {} : input.notes;
    if (!id(input?.paymentId) || !minor(input?.amountMinor) || typeof input?.receipt !== 'string' ||
        !/^[A-Za-z0-9_-]{10,40}$/.test(input.receipt) || !notesOk(notes, 14)) {
      throw new TypeError('invalid_razorpay_refund');
    }
    // Razorpay supports X-Refund-Idempotency for refund retries. Persist and reuse
    // this stable key for the same refund request; do not generate a new one on retry.
    const refund = await this.request('POST', '/payments/' + encodeURIComponent(input.paymentId) + '/refund', {
      amount: input.amountMinor, notes: { ...notes, aurelia_refund_reference: input.receipt }
    }, { 'X-Refund-Idempotency': input.receipt });
    if (!id(refund?.id) || refund.payment_id !== input.paymentId || refund.amount !== input.amountMinor ||
        refund.currency !== 'INR' || typeof refund.status !== 'string' || !refund.status) {
      throw new Error('razorpay_refund_response_binding_mismatch');
    }
    return { provider: 'razorpay', refundId: refund.id, paymentId: refund.payment_id,
      status: refund.status, amountMinor: refund.amount, currency: refund.currency };
  }

  async getRefundStatus(input) {
    if (!id(input?.refundId) || (input.paymentId != null && !id(input.paymentId))) {
      throw new TypeError('invalid_razorpay_refund_id');
    }
    const refund = await this.request('GET', '/refunds/' + encodeURIComponent(input.refundId));
    if (refund.id !== input.refundId) throw new Error('razorpay_refund_identity_mismatch');
    if (input.paymentId && refund.payment_id !== input.paymentId) throw new Error('razorpay_refund_payment_mismatch');
    if (!minor(refund.amount) || refund.currency !== 'INR' || typeof refund.status !== 'string' || !refund.status) {
      throw new Error('razorpay_refund_amount_or_currency_invalid');
    }
    return { provider: 'razorpay', refundId: refund.id, paymentId: refund.payment_id,
      status: refund.status, amountMinor: refund.amount, currency: refund.currency };
  }
}