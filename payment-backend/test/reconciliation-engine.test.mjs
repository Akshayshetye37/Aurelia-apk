import test from 'node:test';
import assert from 'node:assert/strict';
import { runDurableReconciliationWorker } from '../src/workers/reconciliation-engine.mjs';

function fakeDb(docs) {
  const updates = [];
  const collection = name => ({
    where() { return this; },
    limit() { return this; },
    async get() { return { size: docs.length, docs }; },
    doc(id) {
      return { id, async set(data, options) { updates.push({ name, id, data, options }); } };
    }
  });
  return { collection, updates };
}

const valid = (overrides = {}) => ({
  id: 'intent-123',
  data: () => ({
    tenantId: 'tenant1', provider: 'razorpay', environment: 'test',
    providerOrderId: 'order_123', providerPaymentId: 'pay_123', providerEventId: 'evt_123',
    amountMinor: 25000, currency: 'INR', folioId: 'folio1',
    providerVerifiedStatus: 'CAPTURED', accountingStatus: 'PENDING',
    ...overrides
  })
});

test('reconciliation re-verifies provider binding then posts once via settlement contract', async () => {
  const db = fakeDb([valid()]);
  const calls = [];
  const result = await runDurableReconciliationWorker({
    db, tenantId: 'tenant1',
    adapterResolver: async () => ({
      async getPaymentStatus(input) {
        calls.push(input);
        return { orderId: 'order_123', paymentId: 'pay_123', amountMinor: 25000,
          currency: 'INR', captured: true, paymentStatus: 'captured' };
      }
    }),
    settle: async input => { calls.push(input); return { ...input, posted: true, durableReadBack: true, ledgerReceiptId: 'ledger-receipt-123' }; }
  });
  assert.equal(result.posted, 1);
  assert.equal(result.failed, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].eventId, 'reconciliation:intent-123');
  assert.equal(calls[1].tenantId, 'tenant1');
  assert.equal(calls[1].amountMinor, 25000);
  assert.equal(result.items[0].ledgerReceiptId, 'ledger-receipt-123');
  assert.ok(db.updates.some(update => update.name === 'paymentWebhookInbox' &&
    update.data.processingStatus === 'POSTED_TO_FOLIO'));
});

test('non-captured provider status remains pending and is not settled', async () => {
  const db = fakeDb([valid()]);
  let settled = false;
  const result = await runDurableReconciliationWorker({
    db, tenantId: 'tenant1',
    adapterResolver: async () => ({ async getPaymentStatus() {
      return { orderId: 'order_123', paymentId: 'pay_123', amountMinor: 25000,
        currency: 'INR', captured: false, paymentStatus: 'authorized' };
    }}),
    settle: async () => { settled = true; }
  });
  assert.equal(result.stillPending, 1);
  assert.equal(settled, false);
});

test('provider identity mismatch is quarantined for reconciliation', async () => {
  const db = fakeDb([valid()]);
  const result = await runDurableReconciliationWorker({
    db, tenantId: 'tenant1',
    adapterResolver: async () => ({ async getPaymentStatus() {
      return { orderId: 'wrong', paymentId: 'pay_123', amountMinor: 25000,
        currency: 'INR', captured: true, paymentStatus: 'captured' };
    }}),
    settle: async () => assert.fail('must not settle a mismatched payment')
  });
  assert.equal(result.failed, 1);
  assert.equal(db.updates[0].data.accountingStatus, 'RECONCILIATION_REQUIRED');
});

test('worker enforces a hard batch maximum', async () => {
  await assert.rejects(() => runDurableReconciliationWorker({
    db: fakeDb([]), tenantId: 'tenant1', adapterResolver: async () => ({}), limit: 51
  }), /batch_limit/);
});


test('capture is not marked posted without durable canonical ledger read-back proof', async () => {
  const db = fakeDb([valid()]);
  const result = await runDurableReconciliationWorker({
    db, tenantId: 'tenant1',
    adapterResolver: async () => ({ async getPaymentStatus() {
      return { orderId: 'order_123', paymentId: 'pay_123', amountMinor: 25000,
        currency: 'INR', captured: true, paymentStatus: 'captured' };
    }}),
    settle: async input => ({ ...input, posted: true, durableReadBack: false, ledgerReceiptId: 'unverified' })
  });
  assert.equal(result.posted, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.items[0].result, 'RECONCILIATION_REQUIRED');
  assert.ok(db.updates.some(update => update.name === 'paymentIntents' &&
    update.data.accountingStatus === 'RECONCILIATION_REQUIRED'));
  assert.ok(!db.updates.some(update => update.name === 'paymentWebhookInbox' &&
    update.data.processingStatus === 'POSTED_TO_FOLIO'));
});

test('worker refuses to use an implicit settlement implementation', async () => {
  await assert.rejects(() => runDurableReconciliationWorker({
    db: fakeDb([]), tenantId: 'tenant1', adapterResolver: async () => ({})
  }), /dependencies_required/);
});


test('worker rejects durable receipt proof bound to a different folio or amount', async () => {
  const db = fakeDb([valid()]);
  const result = await runDurableReconciliationWorker({
    db, tenantId: 'tenant1',
    adapterResolver: async () => ({ async getPaymentStatus() {
      return { orderId: 'order_123', paymentId: 'pay_123', amountMinor: 25000,
        currency: 'INR', captured: true, paymentStatus: 'captured' };
    }}),
    settle: async input => ({
      ...input, folioId: 'another-folio', amountMinor: 1,
      posted: true, durableReadBack: true, ledgerReceiptId: 'wrong-binding-receipt'
    })
  });
  assert.equal(result.posted, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.items[0].result, 'RECONCILIATION_REQUIRED');
  assert.ok(!db.updates.some(update => update.name === 'paymentWebhookInbox' &&
    update.data.processingStatus === 'POSTED_TO_FOLIO'));
});
