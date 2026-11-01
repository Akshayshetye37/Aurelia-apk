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
        'Content-Type': 'application/json',
        Accept: 'application/json'
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

  async getPaymentStatus(input) {
    if (!id(input?.paymentId) && !id(input?.orderId)) throw new TypeError('payment_or_order_id_required');
    const path = input.paymentId
      ? '/payments/' + encodeURIComponent(input.paymentId)
      : '/orders/' + encodeURIComponent(input.orderId) + '/payments';
    const data = await this.request('GET', path);
    const payment = Array.isArray(data.items) ? data.items.find(p => ['captured', 'authorized', 'failed'].includes(p.status)) || data.items[0] : data;
    if (!payment) return { provider: 'razorpay', orderId: input.orderId, paymentStatus: 'pending' };
    return { provider: 'razorpay', orderId: payment.order_id || input.orderId,
      paymentId: payment.id, paymentStatus: payment.status,
      amountMinor: payment.amount, currency: payment.currency,
      captured: payment.captured === true };
  }

  async verifyWebhook(rawBody, headers) {
    const signature = headers['x-razorpay-signature'] || headers['X-Razorpay-Signature'];
    if (!Buffer.isBuffer(rawBody) || typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) {
      return { valid: false };
    }
    const expected = crypto.createHmac('sha256', this.credentials.webhookSecret).update(rawBody).digest();
    const received = Buffer.from(signature, 'hex');
    const valid = received.length === expected.length && crypto.timingSafeEqual(received, expected);
    return { valid, ...(valid ? { event: JSON.parse(rawBody.toString('utf8')) } : {}) };
  }

  async createRefund(input) {
    if (!id(input?.paymentId) || !minor(input?.amountMinor) || !id(input?.receipt)) {
      throw new TypeError('invalid_razorpay_refund');
    }
    const refund = await this.request('POST', '/payments/' + encodeURIComponent(input.paymentId) + '/refund', {
      amount: input.amountMinor, receipt: input.receipt,
      ...(input.notes ? { notes: input.notes } : {})
    });
    return { provider: 'razorpay', refundId: refund.id, status: refund.status,
      amountMinor: refund.amount, currency: refund.currency };
  }
}
