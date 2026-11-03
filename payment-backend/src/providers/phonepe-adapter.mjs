import crypto from 'node:crypto';
import { PaymentProviderAdapter } from './adapter-contract.mjs';

const HOSTS = Object.freeze({ test: 'https://api-preprod.phonepe.com/apis/pg-sandbox',
  live: 'https://api.phonepe.com/apis/pg' });
const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{6,63}$/.test(v);
const minor = v => Number.isSafeInteger(v) && v > 0;

export class PhonePeAdapter extends PaymentProviderAdapter {
  constructor(options) {
    super(options);
    const c = this.credentials;
    if (!['test', 'live'].includes(this.environment) || !c.clientId ||
        !c.clientSecret || !Number.isInteger(Number(c.clientVersion)) ||
        !c.webhookUsername || !c.webhookPassword) throw new TypeError('phonepe_credentials_incomplete');
    this.baseUrl = HOSTS[this.environment];
    this.token = null;
  }
  async accessToken() {
    if (this.token && this.token.expiresAt > Date.now() + 30000) return this.token.value;
    const form = new URLSearchParams({ client_id: this.credentials.clientId,
      client_version: String(this.credentials.clientVersion), client_secret: this.credentials.clientSecret,
      grant_type: 'client_credentials' });
    const response = await this.fetch(this.baseUrl + '/v1/oauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form, signal: AbortSignal.timeout(15000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || typeof data.access_token !== 'string') {
      throw Object.assign(new Error('phonepe_authentication_failed'), { providerStatus: response.status });
    }
    this.token = { value: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 0) * 1000 };
    return this.token.value;
  }
  async request(method, path, body) {
    const token = await this.accessToken();
    const response = await this.fetch(this.baseUrl + path, {
      method, headers: { Authorization: 'O-Bearer ' + token, 'Content-Type': 'application/json',
        Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error('phonepe_request_failed'), { providerStatus: response.status });
    return data;
  }
  async validateCredentials() {
    await this.accessToken();
    return { valid: true };
  }
  async createOrder(input) {
    if (!id(input?.orderId) || !minor(input?.amountMinor) || input.currency !== 'INR' ||
        typeof input.returnUrl !== 'string' || !input.returnUrl.startsWith('https://')) {
      throw new TypeError('invalid_phonepe_order');
    }
    const data = await this.request('POST', '/checkout/v2/pay', {
      merchantOrderId: input.orderId, amount: input.amountMinor,
      expireAfter: 1200,
      paymentFlow: { type: 'PG_CHECKOUT', message: 'Aurelia folio payment',
        merchantUrls: { redirectUrl: input.returnUrl } }
    });
    const redirectUrl = data.redirectUrl || data.redirectInfo?.url;
    if (typeof redirectUrl !== 'string' || !redirectUrl.startsWith('https://')) {
      throw new Error('phonepe_checkout_url_missing');
    }
    return { provider: 'phonepe', orderId: input.orderId, amountMinor: input.amountMinor,
      currency: 'INR', status: data.state || 'PENDING', checkoutUrl: redirectUrl };
  }
  async findOrderByReference(input) {
    const status = await this.getPaymentStatus({ orderId: input?.reference });
    return status.found ? { found: true, orderId: status.orderId, amountMinor: status.amountMinor,
      currency: status.currency, status: status.paymentStatus } : { found: false };
  }
  async getPaymentStatus(input) {
    if (!id(input?.orderId)) throw new TypeError('invalid_phonepe_order_id');
    const data = await this.request('GET', '/checkout/v2/order/' +
      encodeURIComponent(input.orderId) + '/status?details=false');
    const state = String(data.state || '').toUpperCase();
    const payment = Array.isArray(data.paymentDetails) ? data.paymentDetails.find(p =>
      !input.paymentId || String(p.transactionId) === String(input.paymentId)) : null;
    const txnId = payment?.transactionId || data.paymentDetails?.[0]?.transactionId || null;
    return { provider: 'phonepe', orderId: data.orderId || input.orderId,
      paymentId: txnId == null ? null : String(txnId), paymentStatus: state,
      amountMinor: data.amount, currency: 'INR',
      captured: state === 'COMPLETED' && (!input.paymentId || String(txnId) === String(input.paymentId)),
      found: true };
  }
  async verifyWebhook(rawBody, headers) {
    if (!Buffer.isBuffer(rawBody)) return { valid: false };
    const authorization = headers.authorization || headers.Authorization || '';
    const expected = 'Basic ' + Buffer.from(this.credentials.webhookUsername + ':' +
      this.credentials.webhookPassword).toString('base64');
    const a = Buffer.from(String(authorization)), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { valid: false };
    try { return { valid: true, event: JSON.parse(rawBody.toString('utf8')) }; }
    catch { return { valid: false }; }
  }
  async createRefund(input) {
    if (!id(input?.refundId) || !id(input?.orderId) || !minor(input?.amountMinor)) {
      throw new TypeError('invalid_phonepe_refund');
    }
    const data = await this.request('POST', '/payments/v2/refund', {
      merchantRefundId: input.refundId, originalMerchantOrderId: input.orderId,
      amount: input.amountMinor
    });
    return { provider: 'phonepe', refundId: data.refundId || input.refundId,
      status: data.state || 'PENDING', amountMinor: data.amount };
  }
  async getRefundStatus(input) {
    if (!id(input?.refundId)) throw new TypeError('invalid_phonepe_refund_id');
    const data = await this.request('GET', '/payments/v2/refund/' +
      encodeURIComponent(input.refundId) + '/status');
    return { provider: 'phonepe', refundId: data.merchantRefundId || input.refundId,
      status: data.state, amountMinor: data.amount, currency: 'INR' };
  }
}
