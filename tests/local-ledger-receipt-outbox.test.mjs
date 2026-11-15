import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { IndexedDbLocalLedgerReceiptOutbox } from '../src/storage/indexeddb-local-ledger-receipt-outbox.mjs';
import { createAndQueueLocalLedgerReceipt } from '../src/payments/local-ledger-receipt.mjs';

const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const receipt = (overrides = {}) => ({
  receiptId: 'rcpt_123', intentId: '123e4567-e89b-42d3-a456-426614174000',
  signature: 'a'.repeat(86), issuedAt: new Date(NOW).toISOString(),
  expiresAt: new Date(NOW + 300_000).toISOString(), ...overrides
});
function outbox() {
  let current = NOW;
  const store = new IndexedDbLocalLedgerReceiptOutbox({
    indexedDBImpl: new IDBFactory(), cryptoImpl: crypto.webcrypto,
    databaseName: 'receipt-outbox-' + crypto.randomUUID(),
    now: () => new Date(current).toISOString()
  });
  return { store, setNow: value => { current = value; } };
}

test('outbox enqueue is idempotent and rejects a changed payload under the same receipt ID', async () => {
  const { store } = outbox();
  const first = await store.enqueue(receipt());
  const replay = await store.enqueue(receipt());
  assert.equal(first.duplicate, false);
  assert.equal(replay.duplicate, true);
  await assert.rejects(store.enqueue(receipt({ signature: 'b'.repeat(86) })),
    /receipt_outbox_idempotency_conflict/);
});

test('outbox retries preserve receipt identity and use bounded exponential backoff', async () => {
  const { store, setNow } = outbox();
  await store.enqueue(receipt());
  assert.equal((await store.listDue(new Date(NOW).toISOString())).length, 1);
  const attempt = await store.recordAttempt('rcpt_123', new Date(NOW).toISOString());
  assert.equal(attempt.attempts, 1);
  assert.equal(attempt.nextAttemptAt, new Date(NOW + 1000).toISOString());
  assert.equal((await store.listDue(new Date(NOW).toISOString())).length, 0);
  assert.equal((await store.listDue(new Date(NOW + 1000).toISOString())).length, 1);
  setNow(NOW + 1000);
  const second = await store.recordAttempt('rcpt_123');
  assert.equal(second.attempts, 2);
  assert.equal(second.receipt.receiptId, 'rcpt_123');
});

test('expired receipts move to review-required state and are never auto-accepted', async () => {
  const { store } = outbox();
  await store.enqueue(receipt({ expiresAt: new Date(NOW + 1000).toISOString() }));
  assert.deepEqual(await store.sweepExpired(new Date(NOW + 1000).toISOString()), { expired: 1 });
  assert.equal((await store.listDue(new Date(NOW + 1000).toISOString())).length, 0);
  const [review] = await store.listReviewRequired();
  assert.equal(review.status, 'EXPIRED');
  assert.equal(review.rejectionCode, 'RECEIPT_EXPIRED');
});

test('outbox accepts only an explicit backend acceptance bound to the receipt ID', async () => {
  const { store } = outbox();
  await store.enqueue(receipt());
  await assert.rejects(store.markAccepted('rcpt_123', { accepted: true, receiptId: 'other_receipt' }),
    /receipt_outbox_backend_acceptance_unverified/);
  const accepted = await store.markAccepted('rcpt_123', { accepted: true, receiptId: 'rcpt_123' });
  assert.equal(accepted.record.status, 'ACCEPTED');
  assert.equal((await store.markAccepted('rcpt_123', { accepted: true, receiptId: 'rcpt_123' })).duplicate, true);
});

test('rejected receipts remain available for human review', async () => {
  const { store } = outbox();
  await store.enqueue(receipt());
  const rejected = await store.markRejected('rcpt_123', 'provider_capture_binding_mismatch');
  assert.equal(rejected.record.status, 'REJECTED');
  assert.equal((await store.listReviewRequired()).length, 1);
});

test('restarting receipt creation reuses the original signed receipt from the outbox', async () => {
  const { store } = outbox();
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  let signingCalls = 0;
  const sign = async bytes => {
    signingCalls++;
    return crypto.sign('sha256', Buffer.from(bytes), privateKey);
  };
  const options = {
    outbox: store,
    intent: {
      intentId: '123e4567-e89b-42d3-a456-426614174000', tenantId: 'tenant_123',
      folioId: 'folio_123', provider: 'razorpay', environment: 'test',
      providerOrderId: 'order_123', providerPaymentId: 'pay_123',
      amountMinor: 12500, currency: 'INR'
    },
    device: {
      deviceId: 'device_123', keyId: 'key_123', attestationId: 'attestation_123',
      status: 'ACTIVE', hardwareAttested: true
    },
    ledgerEntry: {
      id: 'entry_123', idempotencyKey: 'payment-intent:123e4567-e89b-42d3-a456-426614174000', hash: 'a'.repeat(64),
      committedAt: new Date(NOW - 1000).toISOString()
    },
    readBack: async id => ({
      id, hash: 'a'.repeat(64), committedAt: new Date(NOW - 1000).toISOString()
    }),
    sign, now: () => new Date(NOW), cryptoImpl: crypto.webcrypto
  };
  const first = await createAndQueueLocalLedgerReceipt(options);
  const second = await createAndQueueLocalLedgerReceipt({
    ...options, now: () => new Date(NOW + 60_000)
  });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.receipt.receiptId, first.receipt.receiptId);
  assert.equal(second.receipt.signature, first.receipt.signature);
  assert.equal(signingCalls, 1);
  assert.ok(publicKey);
});


test('local journal post is keyed by intent and repeated posting reuses one entry and one receipt', async () => {
  const { store } = outbox();
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const entries = new Map();
  let postCalls = 0, signingCalls = 0;
  const intent = {
    intentId: '123e4567-e89b-42d3-a456-426614174000', tenantId: 'tenant_123',
    folioId: 'folio_123', provider: 'razorpay', environment: 'test',
    providerOrderId: 'order_123', providerPaymentId: 'pay_123',
    amountMinor: 12500, currency: 'INR'
  };
  const device = {
    deviceId: 'device_123', keyId: 'key_123', attestationId: 'attestation_123',
    status: 'ACTIVE', hardwareAttested: true
  };
  const postLocalEntry = async ({ idempotencyKey }) => {
    postCalls++;
    if (!entries.has(idempotencyKey)) entries.set(idempotencyKey, {
      id: 'entry_123', idempotencyKey, hash: 'a'.repeat(64),
      committedAt: new Date(NOW - 1000).toISOString()
    });
    return entries.get(idempotencyKey);
  };
  const options = {
    postLocalEntry, outbox: store, intent, device,
    readBack: async id => [...entries.values()].find(entry => entry.id === id) || null,
    sign: async bytes => {
      signingCalls++;
      return crypto.sign('sha256', Buffer.from(bytes), privateKey);
    },
    now: () => new Date(NOW), cryptoImpl: crypto.webcrypto
  };
  const first = await postAndQueueLocalLedgerReceipt(options);
  const second = await postAndQueueLocalLedgerReceipt(options);
  assert.equal(postCalls, 2);
  assert.equal(entries.size, 1);
  assert.equal(first.receipt.receiptId, second.receipt.receiptId);
  assert.equal(second.duplicate, true);
  assert.equal(signingCalls, 1);
});

test('local receipt refuses a local post adapter that drops the payment-intent idempotency key', async () => {
  const { store } = outbox();
  await assert.rejects(postAndQueueLocalLedgerReceipt({
    outbox: store,
    intent: { intentId: '123e4567-e89b-42d3-a456-426614174000' },
    postLocalEntry: async () => ({ id: 'entry_1' })
  }), /LOCAL_RECEIPT_LOCAL_POST_IDEMPOTENCY_MISSING/);
});
