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
    const tokenPath = this.environment === 'live' ? '/v1/oauth/token' : '/v1/oauth/token';
    const tokenBase = this.environment === 'live' ? 'https://api.phonepe.com/apis/identity-manager' : this.baseUrl;
    const response = await this.fetch(tokenBase + tokenPath, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form, signal: AbortSignal.timeout(15000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || typeof data.access_token !== 'string') {
      throw Object.assign(new Error('phonepe_authentication_failed'), { providerStatus: response.status });
    }
    const expiresAt = Number(data.expires_at);
    const expiresIn = Number(data.expires_in);
    this.token = { value: data.access_token, expiresAt: Number.isFinite(expiresAt) && expiresAt > 0
      ? expiresAt * 1000 : Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 300) * 1000 };
    return this.token.value;
  }
  async request(method, path, body) {
    const token = await this.accessToken();
    let response;
    try {
      response = await this.fetch(this.baseUrl + path, {
        method, headers: { Authorization: 'O-Bearer ' + token, 'Content-Type': 'application/json',
          Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000)
      });
    } catch (cause) {
      throw Object.assign(new Error('phonepe_network_error'), { outcomeUnknown: method !== 'GET', cause });
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error('phonepe_request_failed'), {
      providerStatus: response.status, outcomeUnknown: method !== 'GET' && response.status >= 500
    });
    return data;
  }
  async validateCredentials() {
    await this.accessToken();
    return { valid: true };
  }
  async createOrder(input) {
    let returnUrl;
    try { returnUrl = new URL(input?.returnUrl); } catch { returnUrl = null; }
    if (!id(input?.orderId) || !minor(input?.amountMinor) || input.currency !== 'INR' ||
        !returnUrl || returnUrl.protocol !== 'https:') {
      throw new TypeError('invalid_phonepe_order');
    }
    const data = await this.request('POST', '/checkout/v2/pay', {
      merchantOrderId: input.orderId, amount: input.amountMinor,
      expireAfter: 1200,
      paymentFlow: { type: 'PG_CHECKOUT', message: 'Aurelia folio payment',
        merchantUrls: { redirectUrl: input.returnUrl } }
    });
    // PhonePe's response.orderId is its provider-generated order identifier;
    // merchantOrderId is the merchant's request identifier.
    if (data.merchantOrderId != null && data.merchantOrderId !== input.orderId) {
      throw new Error('phonepe_checkout_order_binding_mismatch');
    }
    const redirectUrl = data.redirectUrl || data.redirectInfo?.url;
    let checkoutUrl;
    try { checkoutUrl = new URL(redirectUrl); } catch { checkoutUrl = null; }
    if (!checkoutUrl || checkoutUrl.protocol !== 'https:') {
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
    if (!id(input?.orderId) || (input.paymentId != null && !id(String(input.paymentId)))) {
      throw new TypeError('invalid_phonepe_order_id');
    }
    const data = await this.request('GET', '/checkout/v2/order/' +
      encodeURIComponent(input.orderId) + '/status?details=false');
    if (data.merchantOrderId != null && data.merchantOrderId !== input.orderId) {
      throw new Error('phonepe_status_order_identity_mismatch');
    }
    const state = String(data.state || '').toUpperCase();
    const paymentList = Array.isArray(data.paymentDetails) ? data.paymentDetails : [];
    const payment = input.paymentId
      ? paymentList.find(p => String(p.transactionId) === String(input.paymentId))
      : (paymentList.find(p => String(p.state || '').toUpperCase() === 'COMPLETED') || paymentList[0] || null);
    const txnId = payment?.transactionId ?? null;
    const amountMinor = input.paymentId ? payment?.amount : (payment?.amount ?? data.amount);
    const captured = state === 'COMPLETED' && Boolean(payment) &&
      String(payment.state || '').toUpperCase() === 'COMPLETED' && minor(amountMinor) &&
      (!input.paymentId || String(txnId) === String(input.paymentId));
    return { provider: 'phonepe', orderId: input.orderId,
      paymentId: txnId == null ? null : String(txnId),
      paymentStatus: input.paymentId && !payment ? 'NOT_FOUND' : (payment?.state || state),
      amountMinor: minor(amountMinor) ? amountMinor : null, currency: 'INR',
      captured, found: !input.paymentId || Boolean(payment) };
  }
  async verifyWebhook(rawBody, headers = {}) {
    if (!Buffer.isBuffer(rawBody) || !this.credentials.webhookUsername || !this.credentials.webhookPassword) {
      return { valid: false };
    }
    const authorization = String(headers.authorization || headers.Authorization || '').trim();
    const digest = crypto.createHash('sha256')
      .update(this.credentials.webhookUsername + ':' + this.credentials.webhookPassword, 'utf8')
      .digest('hex');
    const expected = 'SHA256(' + digest + ')';
    const a = Buffer.from(authorization);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { valid: false };
    try {
      const event = JSON.parse(rawBody.toString('utf8'));
      if (!event || typeof event !== 'object' || !event.payload ||
          typeof event.event !== 'string' || !id(event.payload.merchantOrderId)) {
        return { valid: false };
      }
      return { valid: true, event };
    } catch { return { valid: false }; }
  }

  async createRefund(input) {
    if (!id(input?.refundId) || !id(input?.orderId) || !minor(input?.amountMinor) || input.amountMinor < 100) {
      throw new TypeError('invalid_phonepe_refund');
    }
    const data = await this.request('POST', '/payments/v2/refund', {
      merchantRefundId: input.refundId, originalMerchantOrderId: input.orderId,
      amount: input.amountMinor
    });
    if ((data.originalMerchantOrderId != null && data.originalMerchantOrderId !== input.orderId) ||
        (data.merchantRefundId != null && data.merchantRefundId !== input.refundId) ||
        data.amount !== input.amountMinor ||
        !['PENDING','COMPLETED'].includes(String(data.state || '').toUpperCase())) {
      throw new Error('phonepe_refund_response_binding_mismatch');
    }
    return { provider: 'phonepe', refundId: input.refundId,
      providerRefundId: data.refundId == null ? null : String(data.refundId),
      status: String(data.state).toUpperCase(), amountMinor: data.amount, currency: 'INR' };
  }
  async getRefundStatus(input) {
    if (!id(input?.refundId) || !id(input?.orderId)) throw new TypeError('invalid_phonepe_refund_id');
    const data = await this.request('GET', '/payments/v2/refund/' +
      encodeURIComponent(input.refundId) + '/status');
    if (data.originalMerchantOrderId !== input.orderId ||
        (data.merchantRefundId != null && data.merchantRefundId !== input.refundId) ||
        !['PENDING','COMPLETED','FAILED'].includes(String(data.state || '').toUpperCase()) ||
        !minor(data.amount)) throw new Error('phonepe_refund_status_identity_mismatch');
    return { provider: 'phonepe', refundId: input.refundId, providerRefundId: data.refundId == null ? null : String(data.refundId),
      status: data.state, amountMinor: data.amount, currency: 'INR' };
  }
}
