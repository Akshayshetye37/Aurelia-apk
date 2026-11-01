import test from 'node:test';
import assert from 'node:assert/strict';
import { FirestorePaymentRepository } from '../src/intents/firestore-repository.mjs';

class FakeFirestore {
  constructor() { this.docs = new Map(); this.tail = Promise.resolve(); }
  collection(name) {
    return { doc: id => ({ path: name + '/' + id }) };
  }
  async runTransaction(fn) {
    // Serialize fake transactions to model Firestore's serializable commit/retry result.
    const previous = this.tail;
    let release;
    this.tail = new Promise(resolve => { release = resolve; });
    await previous;
    const writes = [];
    const tx = {
      get: async ref => {
        const value = this.docs.get(ref.path);
        return { exists: value !== undefined, data: () => value && structuredClone(value) };
      },
      create: (ref, value) => writes.push(['create', ref.path, structuredClone(value)]),
      set: (ref, value) => writes.push(['set', ref.path, structuredClone(value)]),
      update: (ref, value) => writes.push(['update', ref.path, structuredClone(value)])
    };
    try {
      const result = await fn(tx);
      for (const [op, path, value] of writes) {
        if (op === 'create' && this.docs.has(path)) throw new Error('already_exists');
        this.docs.set(path, { ...(op === 'update' ? this.docs.get(path) : {}), ...value });
      }
      return result;
    } finally { release(); }
  }
  seed(path, value) { this.docs.set(path, value); }
  async get(path) { return this.docs.get(path); }
}
function membershipDb(db) {
  const original = db.collection.bind(db);
  db.collection = name => {
    const collection = original(name);
    if (name === 'paymentMemberships') {
      const doc = collection.doc;
      collection.doc = id => ({
        get: async () => {
          const value = db.docs.get(name + '/' + id);
          return { exists: value !== undefined, data: () => value };
        }
      });
    }
    return collection;
  };
  return db;
}
const payload = (overrides = {}) => ({
  folioId: 'folio_123', amountMinor: 450000, currency: 'INR',
  provider: 'razorpay', environment: 'test', idempotencyKey: 'checkout-key-12345',
  ...overrides
});
const setup = ({ createOrder } = {}) => {
  const db = membershipDb(new FakeFirestore());
  db.seed('paymentMemberships/user_123', { tenantId: 'hotel_123', role: 'owner', status: 'active' });
  let dispatches = 0;
  const repo = new FirestorePaymentRepository({
    db,
    secretManager: { getProviderSecrets: async () => ({ keyId: 'test', keySecret: 'secret', webhookSecret: 'hook' }) },
    providerFactory: () => ({ createOrder: async input => {
      dispatches++;
      return createOrder ? createOrder(input) : {
        orderId: 'order_123', amountMinor: input.amountMinor,
        currency: input.currency, keyId: 'rzp_test_12345678'
      };
    } })
  });
  return { db, repo, get dispatches() { return dispatches; } };
};

test('same idempotency key under concurrency reserves once and dispatches once', async () => {
  const s = setup();
  const results = await Promise.all(Array.from({ length: 12 }, () => s.repo.initializePaymentIntent('user_123', payload())));
  assert.equal(s.dispatches, 1);
  assert.equal(results.filter(r => !r.isDuplicate).length, 1);
  assert.equal(results.filter(r => r.isDuplicate).length, 11);
  assert.equal(new Set(results.map(r => r.intentId)).size, 1);
});

test('different idempotency keys cannot reserve the same folio concurrently', async () => {
  const s = setup();
  const results = await Promise.allSettled([
    s.repo.initializePaymentIntent('user_123', payload({ idempotencyKey: 'checkout-key-aaaaa' })),
    s.repo.initializePaymentIntent('user_123', payload({ idempotencyKey: 'checkout-key-bbbbb' }))
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason.statusCode === 409).length, 1);
  assert.equal(s.dispatches, 1);
});

test('same idempotency key with changed amount is rejected', async () => {
  const s = setup();
  await s.repo.initializePaymentIntent('user_123', payload());
  await assert.rejects(
    s.repo.initializePaymentIntent('user_123', payload({ amountMinor: 450001 })),
    /idempotency_key_payload_conflict/
  );
  assert.equal(s.dispatches, 1);
});

test('provider ambiguity retains UNKNOWN folio lock and never retries provider call', async () => {
  const s = setup({ createOrder: async () => { throw new Error('network timeout'); } });
  const first = await s.repo.initializePaymentIntent('user_123', payload());
  assert.equal(first.status, 'UNKNOWN');
  await assert.rejects(
    s.repo.initializePaymentIntent('user_123', payload({ idempotencyKey: 'another-key-12345' })),
    /folio_payment_already_in_progress/
  );
  assert.equal(s.dispatches, 1);
});

test('inactive or roleless membership cannot initialize an intent', async () => {
  const s = setup();
  s.db.seed('paymentMemberships/user_123', { tenantId: 'hotel_123', role: 'viewer', status: 'active' });
  await assert.rejects(s.repo.initializePaymentIntent('user_123', payload()), /active_tenant_membership_required/);
  assert.equal(s.dispatches, 0);
});

test('invalid floating-point money is rejected before Firestore reservation', async () => {
  const s = setup();
  await assert.rejects(s.repo.initializePaymentIntent('user_123', payload({ amountMinor: 4500.5 })), /invalid_payment_intent_request/);
  assert.equal(s.dispatches, 0);
});

test('Cashfree accepts valid international and domestic phone formats', async () => {
  for (const phone of ['9999999999', '+919999999999']) {
    const s = setup({
      createOrder: async input => ({
        orderId: 'cf_order_123', amountMinor: input.amountMinor,
        currency: input.currency, paymentSessionId: 'cf_session_123',
        checkoutUrl: 'https://checkout.example/session'
      })
    });
    const result = await s.repo.initializePaymentIntent('user_123', payload({
      provider: 'cashfree',
      customer: { id: 'guest_123', phone },
      returnUrl: 'https://pms.example/payment-return'
    }));
    assert.equal(result.status, 'CREATED');
    assert.equal(s.dispatches, 1);
  }
});

test('Cashfree rejects malformed phone numbers before provider dispatch', async () => {
  const s = setup();
  await assert.rejects(
    s.repo.initializePaymentIntent('user_123', payload({
      provider: 'cashfree',
      customer: { id: 'guest_123', phone: '+12abc' },
      returnUrl: 'https://pms.example/payment-return'
    })),
    /cashfree_customer_and_https_return_url_required/
  );
  assert.equal(s.dispatches, 0);
});
