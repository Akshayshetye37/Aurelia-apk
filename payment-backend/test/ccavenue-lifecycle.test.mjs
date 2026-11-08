import test from 'node:test';
import assert from 'node:assert/strict';
import { CCAvenueCrypto } from '../src/providers/ccavenue-crypto.mjs';
import { CCAvenueVerificationService } from '../src/providers/ccavenue-verification.mjs';
import { reconcileCcaVenueNotification } from '../src/providers/ccavenue-notification.mjs';

const KEY = '1234567890123456';
const ACCESS = 'ABCD1234EFGH5678';
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
  if (payload !== null) fields.set('enc_response', new CCAvenueCrypto(KEY).encrypt(JSON.stringify(payload)));
  return { ok: true, status: 200, text: async () => fields.toString() };
}
function service(fetchImpl) {
  return new CCAvenueVerificationService({
    encryptionKey: KEY, accessCode: ACCESS, environment: 'test', fetchImpl
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
  assert.deepEqual(JSON.parse(new CCAvenueCrypto(KEY).decrypt(form.get('enc_request'))), {
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
  const body = { encResp: new CCAvenueCrypto(KEY).encrypt(plaintext) };
  let recorded = null, resolved = null, verifierInput = null;
  const result = await reconcileCcaVenueNotification({
    body, notificationWorkingKey: KEY,
    resolveExpectedPayment: async orderId => { resolved = orderId; return EXPECTED; },
    createVerificationService: async expected => ({
      async verifyOrderStatus(input) {
        verifierInput = input;
        return { provider: 'ccavenue', orderId: expected.orderId, trackingId: '212016048802',
          paymentStatus: 'CAPTURED', providerStatus: 'Successful', amountMinor: expected.amountMinor,
          currency: expected.currency, verified: true };
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
  const body = { encResp: new CCAvenueCrypto(KEY).encrypt(
    'order_id=' + EXPECTED.orderId + '&tracking_id=212016048802&merchant_param1=attackerTenant&amount=0.01') };
  let persisted = false;
  await assert.rejects(reconcileCcaVenueNotification({
    body, notificationWorkingKey: KEY,
    resolveExpectedPayment: async () => ({ ...EXPECTED, amountMinor: 1 }),
    createVerificationService: async () => ({ verifyOrderStatus: async () => { throw new Error('provider_unavailable'); } }),
    recordVerifiedEvidence: async () => { persisted = true; }
  }), /provider_unavailable/);
  assert.equal(persisted, false);
});
