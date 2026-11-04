import crypto from 'node:crypto';
import { PaymentProviderAdapter } from './adapter-contract.mjs';

const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const minor = value => Number.isSafeInteger(value) && value > 0;

export class RazorpayAdapter extends PaymentProviderAdapter {
  constructor(options) {
    super(options);
    if (!['test', 'live'].includes(this.environment)) throw new TypeError('unsupported_environment');
    if (!this.credentials.keyId || !this.credentials.keySecret || !this.credentials.webhookSecret) {
      throw new TypeError('razorpay_credentials_incomplete');
    }
    if ((this.environment === 'test') !== this.credentials.keyId.startsWith('rzp_test_') ||
        (this.environment === 'live') !== this.credentials.keyId.startsWith('rzp_live_')) {
      throw new TypeError('razorpay_key_environment_mismatch');
    }
    this.baseUrl = 'https://api.razorpay.com/v1';
  }

  async request(method, path, body) {
    const response = await this.fetch(this.baseUrl + path, {
      method,
      headers: {
        Authorization: 'Basic ' + Buffer.from(this.credentials.keyId + ':' + this.credentials.keySecret).toString('base64'),
        'Content-Type': 'application/json', Accept: 'application/json'
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error('razorpay_request_failed'), { providerStatus: response.status });
    return data;
  }

  async validateCredentials() {
    await this.request('GET', '/orders?count=1');
    return { valid: true };
  }

  async createOrder(input) {
    if (!minor(input?.amountMinor) || input.currency !== 'INR' || !id(input?.receipt)) {
      throw new TypeError('invalid_razorpay_order');
    }
    const order = await this.request('POST', '/orders', {
      amount: input.amountMinor, currency: 'INR', receipt: input.receipt,
      ...(input.notes ? { notes: input.notes } : {})
    });
    return { provider: 'razorpay', orderId: order.id, amountMinor: order.amount,
      currency: order.currency, status: order.status, keyId: this.credentials.keyId };
  }

  async findOrderByReference(input) {
    if (!id(input?.reference)) throw new TypeError('invalid_razorpay_receipt');
    const data = await this.request('GET', '/orders?receipt=' + encodeURIComponent(input.reference) + '&count=100');
    const matches = Array.isArray(data.items) ? data.items.filter(order => order.receipt === input.reference) : [];
    if (matches.length !== 1) return { found: false, ambiguous: matches.length > 1 };
    const order = matches[0];
    return { found: true, orderId: order.id, amountMinor: order.amount,
      currency: order.currency, receipt: order.receipt, status: order.status };
  }

  async getPaymentStatus(input) {
    if (!id(input?.paymentId) && !id(input?.orderId)) throw new TypeError('payment_or_order_id_required');
    const path = input.paymentId ? '/payments/' + encodeURIComponent(input.paymentId)
      : '/orders/' + encodeURIComponent(input.orderId) + '/payments';
    const data = await this.request('GET', path);
    const orderedPayments = Array.isArray(data.items)
      ? [...data.items].sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0)) : null;
    const payment = orderedPayments
      ? (input.paymentId ? orderedPayments.find(p => p.id === input.paymentId) : orderedPayments[0])
      : (input.paymentId ? (data.id === input.paymentId ? data : null) : data);
    if (!payment) return { provider: 'razorpay', orderId: input.orderId, paymentId: null,
      paymentStatus: 'pending', captured: false };
    return { provider: 'razorpay', orderId: payment.order_id || null,
      paymentId: payment.id, paymentStatus: payment.status, amountMinor: payment.amount,
      currency: payment.currency, captured: payment.captured === true };
  }

  async verifyWebhook(rawBody, headers) {
    const signature = headers['x-razorpay-signature'] || headers['X-Razorpay-Signature'];
    if (!Buffer.isBuffer(rawBody) || typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) return { valid: false };
    const expected = crypto.createHmac('sha256', this.credentials.webhookSecret).update(rawBody).digest();
    const received = Buffer.from(signature, 'hex');
    const valid = received.length === expected.length && crypto.timingSafeEqual(received, expected);
    if (!valid) return { valid: false };
    try { return { valid: true, event: JSON.parse(rawBody.toString('utf8')) }; }
    catch { return { valid: false }; }
  }

  async createRefund(input) {
    const notes = input?.notes == null ? {} : input.notes;
    if (!id(input?.paymentId) || !minor(input?.amountMinor) || !id(input?.receipt) ||
        !notes || typeof notes !== 'object' || Array.isArray(notes)) {
      throw new TypeError('invalid_razorpay_refund');
    }
    const refund = await this.request('POST', '/payments/' + encodeURIComponent(input.paymentId) + '/refund', {
      amount: input.amountMinor, notes: { ...notes, aurelia_refund_reference: input.receipt }
    });
    if (!id(refund?.id) || refund.payment_id !== input.paymentId ||
        refund.amount !== input.amountMinor || refund.currency !== 'INR' ||
        typeof refund.status !== 'string' || !refund.status) {
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
    if (!Number.isSafeInteger(refund.amount) || refund.amount <= 0 ||
        refund.currency !== 'INR' || typeof refund.status !== 'string' || !refund.status) {
      throw new Error('razorpay_refund_amount_or_currency_invalid');
    }
    return { provider: 'razorpay', refundId: refund.id, paymentId: refund.payment_id,
      status: refund.status, amountMinor: refund.amount, currency: refund.currency };
  }
}
