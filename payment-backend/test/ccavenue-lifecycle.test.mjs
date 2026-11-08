import test from 'node:test';
import assert from 'node:assert/strict';
import { CCAvenueCrypto } from '../src/providers/ccavenue-crypto.mjs';
import { CCAvenueVerificationService } from '../src/providers/ccavenue-verification.mjs';
import { reconcileCcaVenueNotification } from '../src/providers/ccavenue-notification.mjs';

const KEY = '1234567890123456';
const fixtureKey = (...parts) => parts.join('-') + '-fixture';
const API_KEY = fixtureKey('api', 'encryption', 'key');
const HOSTED_KEY = fixtureKey('hosted', 'checkout', 'key');
const NOTIFY_KEY = fixtureKey('notification', 'working', 'key');
const ACCESS = ['ABCD', '1234', 'EFGH', '5678'].join('');
const EXPECTED = { provider: 'ccavenue', tenantId: 'tenant_123', paymentIntentId: 'intent_123',
  orderId: 'AUR-ORDER-0001', amountMinor: 125050, currency: 'INR' };

function jsonStatus(status = 'Successful', patch = {}) {
  return { Order_Status_Result: {
    status: 0, order_no: EXPECTED.orderId, reference_no: '212016048802',
    order_amt: '1250.50', order_currncy: 'INR', order_status: status,
    order_bank_ref_no: 'BANK123', order_fraud_status: 'NA', ...patch
  }};
}
function apiResponse(payload, status = '0') {
  const fields = new URLSearchParams({ status });
  if (payload !== null) fields.set('enc_response', new CCAvenueCrypto(API_KEY).encrypt(JSON.stringify(payload)));
  return { ok: true, status: 200, text: async () => fields.toString() };
}
function service(fetchImpl) {
  return new CCAvenueVerificationService({
    encryptionKey: API_KEY, accessCode: ACCESS, environment: 'test', fetchImpl
  });
}

test('CCAvenue AES codec matches deterministic compatibility vector and round-trips', () => {
  const codec = new CCAvenueCrypto(KEY);
  assert.equal(codec.encrypt('order_no=AUR-TEST-1'),
    '66c1ce4e2fed107ba8527721208fc25b1287691231e5e57b7f1be66297af995f');
  assert.equal(codec.decrypt(codec.encrypt('order_no=AUR-TEST-1')), 'order_no=AUR-TEST-1');
});

test('CCAvenue AES codec rejects malformed ciphertext, invalid keys and oversized input', () => {
  assert.throws(() => new CCAvenueCrypto(''));
  assert.throws(() => new CCAvenueCrypto('bad\nkey'));
  const codec = new CCAvenueCrypto(KEY);
  assert.throws(() => codec.decrypt('not-hex'));
  assert.throws(() => codec.decrypt('0011'));
  assert.throws(() => codec.encrypt(''));
});

test('CCAvenue unqualified crypto cannot target live status or checkout endpoints', () => {
  assert.throws(() => new CCAvenueVerificationService({
    encryptionKey: API_KEY, accessCode: ACCESS, environment: 'live'
  }), /test_environment_only/);
  assert.throws(() => new CCAvenueHostedCheckout({
    merchantId: '123456', accessCode: ACCESS, hostedCheckoutKey: HOSTED_KEY, environment: 'live'
  }), /checkout_credentials_invalid/);
});

test('CCAvenue status verifier rejects tracking references longer than the documented 12 digits', async () => {
  await assert.rejects(service(async () => apiResponse(jsonStatus())).verifyOrderStatus({
    orderId: EXPECTED.orderId, trackingId: '1234567890123',
    expectedAmountMinor: EXPECTED.amountMinor, expectedCurrency: 'INR'
  }), /binding_invalid/);
});

test('CCAvenue status verifier sends encrypted API v1.1 orderStatusTracker request to sandbox endpoint', async () => {
  let request;
  const verifier = service(async (url, options) => {
    request = { url, options };
    return apiResponse(jsonStatus());
  });
  const result = await verifier.verifyOrderStatus({
    orderId: EXPECTED.orderId, trackingId: '212016048802',
    expectedAmountMinor: EXPECTED.amountMinor, expectedCurrency: 'INR'
  });
  assert.equal(request.url, 'https://apitest.ccavenue.com/apis/servlet/DoWebTrans');
  assert.equal(request.options.method, 'POST');
  const form = new URLSearchParams(request.options.body);
  assert.equal(form.get('access_code'), ACCESS);
  assert.equal(form.get('command'), 'orderStatusTracker');
  assert.equal(form.get('request_type'), 'JSON');
  assert.equal(form.get('response_type'), 'JSON');
  assert.equal(form.get('version'), '1.1');
  assert.deepEqual(JSON.parse(new CCAvenueCrypto(API_KEY).decrypt(form.get('enc_request'))), {
    order_no: EXPECTED.orderId, reference_no: '212016048802'
  });
  assert.equal(result.paymentStatus, 'CAPTURED');
  assert.equal(result.verified, true);
  assert.equal(result.amountMinor, EXPECTED.amountMinor);
});

test('CCAvenue status verifier maps provider lifecycle states without inventing capture', async () => {
  for (const [providerStatus, expectedState] of [
    ['Successful', 'CAPTURED'], ['Shipped', 'CAPTURED'], ['Awaited', 'PENDING'],
    ['Initiated', 'PENDING'], ['Unsuccessful', 'FAILED'], ['Refunded', 'REFUNDED'],
    ['Auto-Reversed', 'REVERSED'], ['Chargeback', 'DISPUTED'], ['Fraud', 'REVIEW']
  ]) {
    const result = await service(async () => apiResponse(jsonStatus(providerStatus)))
      .verifyOrderStatus({ orderId: EXPECTED.orderId, trackingId: '212016048802',
        expectedAmountMinor: EXPECTED.amountMinor, expectedCurrency: 'INR' });
    assert.equal(result.paymentStatus, expectedState, providerStatus);
  }
});

test('CCAvenue status verifier rejects order, reference, amount and currency mismatches', async () => {
  const run = patch => service(async () => apiResponse(jsonStatus('Successful', patch)))
    .verifyOrderStatus({ orderId: EXPECTED.orderId, trackingId: '212016048802',
      expectedAmountMinor: EXPECTED.amountMinor, expectedCurrency: 'INR' });
  await assert.rejects(run({ order_no: 'OTHER' }), /order_mismatch/);
  await assert.rejects(run({ reference_no: '999999999999' }), /tracking_mismatch/);
  await assert.rejects(run({ order_amt: '1.00' }), /amount_mismatch/);
  await assert.rejects(run({ order_currncy: 'USD' }), /currency_mismatch/);
});

test('CCAvenue status API failures are not decrypted or treated as payment failures', async () => {
  await assert.rejects(service(async () => apiResponse('ignored', '1'))
    .verifyOrderStatus({ orderId: EXPECTED.orderId, expectedAmountMinor: EXPECTED.amountMinor }),
  /status_api_rejected/);
  await assert.rejects(service(async () => ({ ok: false, status: 503, text: async () => '' }))
    .verifyOrderStatus({ orderId: EXPECTED.orderId, expectedAmountMinor: EXPECTED.amountMinor }),
  error => error.message === 'ccavenue_status_http_error' && error.outcomeUnknown === true);
});

test('CCAvenue Dynamic Event Notification only records status after independent server verification', async () => {
  const plaintext = 'order_id=' + EXPECTED.orderId +
    '&tracking_id=212016048802&order_status=Success&currency=INR&amount=1250.50';
  const body = { encResp: new CCAvenueCrypto(NOTIFY_KEY).encrypt(plaintext) };
  let recorded = null, resolved = null, verifierInput = null;
  const result = await reconcileCcaVenueNotification({
    body, notificationWorkingKey: NOTIFY_KEY,
    resolveExpectedPayment: async orderId => { resolved = orderId; return EXPECTED; },
    createVerificationService: async expected => ({
      async verifyOrderStatus(input) {
        verifierInput = input;
        return { provider: 'ccavenue', orderId: expected.orderId, trackingId: '212016048802',
          paymentStatus: 'CAPTURED', providerStatus: 'Successful', amountMinor: expected.amountMinor,
          currency: expected.currency, verified: true, evidenceSource: 'ccavenue_order_status_tracker' };
      }
    }),
    recordVerifiedEvidence: async evidence => { recorded = evidence; }
  });
  assert.equal(resolved, EXPECTED.orderId);
  assert.equal(verifierInput.expectedAmountMinor, EXPECTED.amountMinor);
  assert.equal(recorded.tenantId, EXPECTED.tenantId);
  assert.equal(recorded.verifiedStatus.verified, true);
  assert.equal(result.ledgerPosted, false);
  assert.equal(result.accepted, true);
});

test('CCAvenue Dynamic Event Notification cannot choose tenant/folio/amount and cannot bypass status lookup', async () => {
  const body = { encResp: new CCAvenueCrypto(NOTIFY_KEY).encrypt(
    'order_id=' + EXPECTED.orderId + '&tracking_id=212016048802&merchant_param1=attackerTenant&amount=0.01') };
  let persisted = false;
  await assert.rejects(reconcileCcaVenueNotification({
    body, notificationWorkingKey: NOTIFY_KEY,
    resolveExpectedPayment: async () => ({ ...EXPECTED, amountMinor: 1 }),
    createVerificationService: async () => ({ verifyOrderStatus: async () => { throw new Error('provider_unavailable'); } }),
    recordVerifiedEvidence: async () => { persisted = true; }
  }), /provider_unavailable/);
  assert.equal(persisted, false);
});

import { CCAvenueHostedCheckout } from '../src/providers/ccavenue-hosted-checkout.mjs';

test('CCAvenue hosted checkout builds encrypted v3.3 POST fields without exposing merchant encryption key', () => {
  const checkout = new CCAvenueHostedCheckout({
    merchantId: '123456', accessCode: ACCESS, hostedCheckoutKey: HOSTED_KEY, environment: 'test'
  }).createCheckout({
    orderId: EXPECTED.orderId, amountMinor: EXPECTED.amountMinor, currency: 'INR',
    redirectUrl: 'https://pms.example.com/payment/ccavenue/return',
    cancelUrl: 'https://pms.example.com/payment/ccavenue/cancel'
  });
  assert.equal(checkout.endpoint,
    'https://test.ccavenue.com/transaction/transaction.do?command=initiateTransaction');
  assert.equal(checkout.method, 'POST');
  assert.equal(checkout.fields.access_code, ACCESS);
  const plain = new CCAvenueCrypto(HOSTED_KEY).decrypt(checkout.fields.encRequest);
  const fields = new URLSearchParams(plain);
  assert.equal(fields.get('merchant_id'), '123456');
  assert.equal(fields.get('order_id'), EXPECTED.orderId);
  assert.equal(fields.get('amount'), '1250.50');
  assert.equal(fields.get('currency'), 'INR');
  assert.equal(fields.get('redirect_url'), 'https://pms.example.com/payment/ccavenue/return');
  assert.equal(fields.get('cancel_url'), 'https://pms.example.com/payment/ccavenue/cancel');
  assert.equal(JSON.stringify(checkout).includes(HOSTED_KEY), false);
});

test('CCAvenue hosted checkout rejects insecure URLs and malformed order amounts', () => {
  const checkout = new CCAvenueHostedCheckout({
    merchantId: '123456', accessCode: ACCESS, hostedCheckoutKey: HOSTED_KEY, environment: 'live'
  });
  const input = {
    orderId: EXPECTED.orderId, amountMinor: EXPECTED.amountMinor, currency: 'INR',
    redirectUrl: 'https://pms.example.com/return', cancelUrl: 'https://pms.example.com/cancel'
  };
  assert.throws(() => checkout.createCheckout({ ...input, redirectUrl: 'http://pms.example.com/return' }));
  assert.throws(() => checkout.createCheckout({ ...input, amountMinor: 0 }));
  assert.throws(() => checkout.createCheckout({ ...input, orderId: 'invalid order id' }));
});

test('CCAvenue status verifier accepts the flat JSON response shape shown in API v1.3', async () => {
  const flat = { ...jsonStatus().Order_Status_Result };
  const result = await service(async () => apiResponse(flat))
    .verifyOrderStatus({ orderId: EXPECTED.orderId, trackingId: '212016048802',
      expectedAmountMinor: EXPECTED.amountMinor, expectedCurrency: 'INR' });
  assert.equal(result.paymentStatus, 'CAPTURED');
  assert.equal(result.orderId, EXPECTED.orderId);
});

import { createCcaVenueWebhookHandler } from '../src/webhooks/ccavenue-webhook-router.mjs';

test('CCAvenue webhook handler acknowledges only after verified evidence persistence', async () => {
  const plaintext = 'order_id=' + EXPECTED.orderId + '&tracking_id=212016048802&order_status=Success';
  const handler = createCcaVenueWebhookHandler({
    notificationWorkingKey: NOTIFY_KEY,
    resolveExpectedPayment: async () => EXPECTED,
    createVerificationService: async () => ({
      verifyOrderStatus: async () => ({
        provider: 'ccavenue', orderId: EXPECTED.orderId, trackingId: '212016048802',
        paymentStatus: 'CAPTURED', providerStatus: 'Successful',
        amountMinor: EXPECTED.amountMinor, currency: EXPECTED.currency, verified: true,
        evidenceSource: 'ccavenue_order_status_tracker'
      })
    }),
    recordVerifiedEvidence: async () => {}
  });
  const response = { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; } };
  await handler({ body: { encResp: new CCAvenueCrypto(NOTIFY_KEY).encrypt(plaintext) } }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.reconciled, true);
  assert.equal(response.body.ledgerPosted, false);
});

test('CCAvenue webhook handler does not acknowledge when authoritative status is unavailable', async () => {
  const handler = createCcaVenueWebhookHandler({
    notificationWorkingKey: NOTIFY_KEY,
    resolveExpectedPayment: async () => EXPECTED,
    createVerificationService: async () => ({
      verifyOrderStatus: async () => { throw new Error('ccavenue_status_transport_error'); }
    }),
    recordVerifiedEvidence: async () => {}
  });
  const response = { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; } };
  const plaintext = 'order_id=' + EXPECTED.orderId + '&tracking_id=212016048802';
  await handler({ body: { encResp: new CCAvenueCrypto(NOTIFY_KEY).encrypt(plaintext) } }, response);
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.error, 'provider_reconciliation_unavailable');
});

test('CCAvenue partial capture and high-risk flag do not become full captured payment', async () => {
  const partial = await service(async () => apiResponse(jsonStatus('Successful', {
    order_capt_amt: '500.00'
  }))).verifyOrderStatus({
    orderId: EXPECTED.orderId, trackingId: '212016048802',
    expectedAmountMinor: EXPECTED.amountMinor, expectedCurrency: 'INR'
  });
  assert.equal(partial.paymentStatus, 'PARTIALLY_CAPTURED');
  assert.equal(partial.capturedAmountMinor, 50000);

  const highRisk = await service(async () => apiResponse(jsonStatus('Successful', {
    order_fraud_status: 'High'
  }))).verifyOrderStatus({
    orderId: EXPECTED.orderId, trackingId: '212016048802',
    expectedAmountMinor: EXPECTED.amountMinor, expectedCurrency: 'INR'
  });
  assert.equal(highRisk.paymentStatus, 'REVIEW');
});

test('CCAvenue status verifier normalizes a safe numeric tracking reference without precision loss', async () => {
  const flat = { ...jsonStatus().Order_Status_Result, reference_no: 212016048802 };
  const result = await service(async () => apiResponse(flat))
    .verifyOrderStatus({ orderId: EXPECTED.orderId, trackingId: '212016048802',
      expectedAmountMinor: EXPECTED.amountMinor, expectedCurrency: 'INR' });
  assert.equal(result.trackingId, '212016048802');
});
