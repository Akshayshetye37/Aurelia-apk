import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { FirestorePaymentRepository, paymentFolioDocumentId } from '../src/intents/firestore-repository.mjs';

class FakeFirestore {
  constructor() { this.docs = new Map(); this.tail = Promise.resolve(); }
  collection(name) {
    return { doc: id => ({
      path: name + '/' + id,
      get: async () => {
        const value = this.docs.get(name + '/' + id);
        return { exists: value !== undefined, data: () => value && structuredClone(value) };
      }
    }) };
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
const setup = ({ createOrder, getPaymentStatus, findOrderByReference } = {}) => {
  const db = membershipDb(new FakeFirestore());
  db.seed('paymentMemberships/user_123', { tenantId: 'hotel_123', role: 'owner', status: 'active' });
  db.seed('paymentFolios/' + paymentFolioDocumentId('hotel_123', 'folio_123'), { tenantId: 'hotel_123', folioId: 'folio_123', bookingId: 'booking_123', status: 'open', currency: 'INR', balanceMinor: 1000000, revision: 7 });
  let dispatches = 0;
  const repo = new FirestorePaymentRepository({
    db,
    secretManager: { getProviderSecrets: async () => ({ keyId: 'test', appId: 'cashfree_test', keySecret: 'secret', webhookSecret: 'hook' }) },
    providerFactory: () => ({
      createOrder: async input => {
        dispatches++;
        return createOrder ? createOrder(input) : {
          orderId: 'order_123', amountMinor: input.amountMinor,
          currency: input.currency, keyId: 'rzp_test_12345678'
        };
      },
      getPaymentStatus: async input => getPaymentStatus ? getPaymentStatus(input) : {
        orderId: input.orderId, paymentId: null, paymentStatus: 'created', captured: false
      },
      ...(findOrderByReference ? { findOrderByReference } : {})
    })
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

test('unprovisioned folio cannot create provider order', async () => { const s = setup(); s.db.docs.delete('paymentFolios/' + paymentFolioDocumentId('hotel_123', 'folio_123')); await assert.rejects(s.repo.initializePaymentIntent('user_123', payload()), /authoritative_folio_not_provisioned/); assert.equal(s.dispatches, 0); });
test('amount above authoritative folio balance is rejected before provider dispatch', async () => { const s = setup(); s.db.seed('paymentFolios/' + paymentFolioDocumentId('hotel_123', 'folio_123'), { tenantId: 'hotel_123', folioId: 'folio_123', bookingId: 'booking_123', status: 'open', currency: 'INR', balanceMinor: 1000, revision: 8 }); await assert.rejects(s.repo.initializePaymentIntent('user_123', payload({ amountMinor: 1001 })), /payment_exceeds_authoritative_folio_balance/); assert.equal(s.dispatches, 0); });
test('closed or cross-tenant folio cannot be charged', async () => { const s = setup(); s.db.seed('paymentFolios/' + paymentFolioDocumentId('hotel_123', 'folio_123'), { tenantId: 'other_hotel', folioId: 'folio_123', bookingId: 'booking_123', status: 'closed', currency: 'INR', balanceMinor: 1000000, revision: 9 }); await assert.rejects(s.repo.initializePaymentIntent('user_123', payload()), /folio_not_open_or_authoritative_snapshot_invalid/); assert.equal(s.dispatches, 0); });


test('provider secrets or adapter construction failure is definitively pre-dispatch and releases folio lock', async () => {
  const s = setup();
  const repo = new FirestorePaymentRepository({
    db: s.db,
    secretManager: { getProviderSecrets: async () => { throw new Error('secret_manager_unavailable'); } },
    providerFactory: () => { throw new Error('must_not_construct'); }
  });
  const result = await repo.initializePaymentIntent('user_123', payload());
  assert.equal(result.status, 'FAILED_TO_INITIATE');
  assert.equal(s.dispatches, 0);
  const lock = [...s.db.docs.entries()].find(([path]) => path.startsWith('paymentFolioLocks/'))?.[1];
  assert.equal(lock?.active, false);
});

test('adapter construction failure is pre-dispatch and allows a new attempt after lock release', async () => {
  const s = setup();
  const repo = new FirestorePaymentRepository({
    db: s.db,
    secretManager: { getProviderSecrets: async () => ({ keyId: 'test', keySecret: 'secret', webhookSecret: 'hook' }) },
    providerFactory: () => { throw new Error('adapter_configuration_invalid'); }
  });
  const first = await repo.initializePaymentIntent('user_123', payload());
  assert.equal(first.status, 'FAILED_TO_INITIATE');
  const lock = [...s.db.docs.entries()].find(([path]) => path.startsWith('paymentFolioLocks/'))?.[1];
  assert.equal(lock?.active, false);
});

test('pre-dispatch failure does not permit reuse of the same idempotency key with changed request', async () => {
  const s = setup();
  const repo = new FirestorePaymentRepository({
    db: s.db,
    secretManager: { getProviderSecrets: async () => { throw new Error('secret_manager_unavailable'); } }
  });
  await repo.initializePaymentIntent('user_123', payload());
  await assert.rejects(
    repo.initializePaymentIntent('user_123', payload({ amountMinor: 450001 })),
    /idempotency_key_payload_conflict/
  );
});


test('firestore dispatch-marker failure releases reservation when cleanup commits', async () => {
  const s = setup();
  const originalRunTransaction = s.db.runTransaction.bind(s.db);
  let calls = 0;
  s.db.runTransaction = async fn => {
    calls++;
    // Reservation transaction is first; dispatch marker is second; cleanup is third.
    if (calls === 2) throw new Error('firestore_write_unavailable_before_dispatch');
    return originalRunTransaction(fn);
  };
  await assert.rejects(
    s.repo.initializePaymentIntent('user_123', payload()),
    /firestore_write_unavailable_before_dispatch/
  );
  assert.equal(s.dispatches, 0);
  const intent = [...s.db.docs.entries()].find(([path]) => path.startsWith('paymentIntents/'))?.[1];
  const idem = [...s.db.docs.entries()].find(([path]) => path.startsWith('paymentIntentIdempotency/'))?.[1];
  const lock = [...s.db.docs.entries()].find(([path]) => path.startsWith('paymentFolioLocks/'))?.[1];
  assert.equal(intent?.state, 'FAILED_TO_INITIATE');
  assert.equal(idem?.state, 'FAILED_TO_INITIATE');
  assert.equal(lock?.active, false);

  // A fresh operator-approved attempt can reserve the folio; the failed attempt
  // itself is never redispatched.
  const retry = await s.repo.initializePaymentIntent('user_123', payload({ idempotencyKey: 'checkout-key-retry-123' }));
  assert.equal(retry.status, 'CREATED');
  assert.equal(s.dispatches, 1);
});

test('uncertain dispatch-marker commit is cleaned up before provider invocation', async () => {
  const s = setup();
  const originalRunTransaction = s.db.runTransaction.bind(s.db);
  let calls = 0;
  s.db.runTransaction = async fn => {
    calls++;
    const result = await originalRunTransaction(fn);
    // Simulate a lost transaction response after Firestore committed the marker.
    if (calls === 2) throw new Error('firestore_commit_response_lost');
    return result;
  };
  await assert.rejects(
    s.repo.initializePaymentIntent('user_123', payload()),
    /firestore_commit_response_lost/
  );
  assert.equal(s.dispatches, 0);
  const intent = [...s.db.docs.entries()].find(([path]) => path.startsWith('paymentIntents/'))?.[1];
  const lock = [...s.db.docs.entries()].find(([path]) => path.startsWith('paymentFolioLocks/'))?.[1];
  assert.equal(intent?.state, 'FAILED_TO_INITIATE');
  assert.equal(typeof intent?.providerRequestStartedAt, 'string');
  assert.equal(lock?.active, false);
});

test('failed dispatch-marker cleanup preserves the lock and never calls provider', async () => {
  const s = setup();
  const originalRunTransaction = s.db.runTransaction.bind(s.db);
  let calls = 0;
  s.db.runTransaction = async fn => {
    calls++;
    // Both the dispatch marker and cleanup transaction fail.
    if (calls === 2 || calls === 3) throw new Error('firestore_unavailable');
    return originalRunTransaction(fn);
  };
  await assert.rejects(
    s.repo.initializePaymentIntent('user_123', payload()),
    /firestore_unavailable/
  );
  assert.equal(s.dispatches, 0);
  const lock = [...s.db.docs.entries()].find(([path]) => path.startsWith('paymentFolioLocks/'))?.[1];
  assert.equal(lock?.active, true);
  assert.equal(lock?.state, 'DISPATCHING');
});


test('same Cashfree idempotency key with changed guest or return URL is rejected', async () => {
  const s = setup({
    createOrder: async input => ({
      orderId: 'cf_order_123', amountMinor: input.amountMinor,
      currency: input.currency, paymentSessionId: 'cf_session_123'
    })
  });
  const original = payload({ provider: 'cashfree', customer: { id: 'guest_123', phone: '9999999999' }, returnUrl: 'https://pms.example/payment-return' });
  await s.repo.initializePaymentIntent('user_123', original);
  await assert.rejects(s.repo.initializePaymentIntent('user_123', payload({
    ...original, customer: { id: 'guest_456', phone: '9999999999' }
  })), /idempotency_key_payload_conflict/);
  await assert.rejects(s.repo.initializePaymentIntent('user_123', payload({
    ...original, returnUrl: 'https://pms.example/another-return'
  })), /idempotency_key_payload_conflict/);
  assert.equal(s.dispatches, 1);
});


test('UNKNOWN dispatch recovers an existing provider order by deterministic reference without redispatch', async () => {
  const s = setup({ createOrder: async input => {
    // Simulate the provider creating the order but the response being lost.
    throw new Error('response_lost_after_provider_create');
  }});
  const first = await s.repo.initializePaymentIntent('user_123', payload());
  assert.equal(first.status, 'UNKNOWN');
  const intent = [...s.db.docs.entries()].find(([path]) => path.startsWith('paymentIntents/'))?.[1];
  assert.match(intent.providerReference, /^aur_[a-f0-9]{16}$/);
  const recoveredRepo = new FirestorePaymentRepository({
    db: s.db,
    secretManager: { getProviderSecrets: async () => ({ keyId: 'test', keySecret: 'secret', webhookSecret: 'hook' }) },
    providerFactory: () => ({
      findOrderByReference: async ({ reference }) => ({
        found: true, orderId: 'order_recovered', receipt: reference,
        amountMinor: 450000, currency: 'INR'
      }),
      createOrder: async () => { throw new Error('must_not_redispatch'); }
    })
  });
  const recovered = await recoveredRepo.initializePaymentIntent('user_123', payload());
  assert.equal(recovered.status, 'CREATED');
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.providerOrderId, 'order_recovered');
  assert.equal(s.dispatches, 1);
  const stored = await s.db.get('paymentIntents/' + first.intentId);
  assert.equal(stored.state, 'CREATED');
  assert.equal(stored.providerOrderId, 'order_recovered');
  const lock = [...s.db.docs.entries()].find(([path]) => path.startsWith('paymentFolioLocks/'))?.[1];
  assert.equal(lock.active, true);
  assert.equal(lock.state, 'CREATED');
});

test('UNKNOWN recovery never overwrites a provider order already bound to another intent', async () => {
  const s = setup({ createOrder: async () => { throw new Error('response_lost_after_provider_create'); } });
  const first = await s.repo.initializePaymentIntent('user_123', payload());
  assert.equal(first.status, 'UNKNOWN');
  const orderId = 'order_recovered';
  const orderHash = createHash('sha256')
    .update('hotel_123:razorpay:test:test:' + orderId).digest('hex');
  const priorBinding = {
    tenantId: 'hotel_123', folioId: 'another_folio', intentId: 'another_intent',
    provider: 'razorpay', environment: 'test', providerOrderId: orderId,
    amountMinor: 12345, currency: 'INR'
  };
  s.db.seed('paymentProviderOrders/' + orderHash, priorBinding);

  const recoveryRepo = new FirestorePaymentRepository({
    db: s.db,
    secretManager: { getProviderSecrets: async () => ({ keyId: 'test', keySecret: 'secret', webhookSecret: 'hook' }) },
    providerFactory: () => ({
      findOrderByReference: async ({ reference }) => ({
        found: true, orderId, receipt: reference, amountMinor: 450000, currency: 'INR'
      }),
      createOrder: async () => { throw new Error('must_not_redispatch'); }
    })
  });
  const recovered = await recoveryRepo.initializePaymentIntent('user_123', payload());
  assert.equal(recovered.status, 'UNKNOWN');
  assert.equal(recovered.intentId, first.intentId);
  assert.deepEqual(await s.db.get('paymentProviderOrders/' + orderHash), priorBinding);
  const storedIntent = await s.db.get('paymentIntents/' + first.intentId);
  assert.equal(storedIntent.state, 'UNKNOWN');
  const lock = [...s.db.docs.entries()].find(([path]) => path.startsWith('paymentFolioLocks/'))?.[1];
  assert.equal(lock.active, true);
  assert.equal(s.dispatches, 1);
});

test('UNKNOWN dispatch remains locked when provider lookup is inconclusive', async () => {
  const s = setup({ createOrder: async () => { throw new Error('timeout'); } });
  const first = await s.repo.initializePaymentIntent('user_123', payload());
  const recoveryRepo = new FirestorePaymentRepository({
    db: s.db,
    secretManager: { getProviderSecrets: async () => ({ keyId: 'test', keySecret: 'secret', webhookSecret: 'hook' }) },
    providerFactory: () => ({ findOrderByReference: async () => ({ found: false }) })
  });
  const duplicate = await recoveryRepo.initializePaymentIntent('user_123', payload());
  assert.equal(duplicate.status, 'UNKNOWN');
  assert.equal(duplicate.intentId, first.intentId);
  const lock = [...s.db.docs.entries()].find(([path]) => path.startsWith('paymentFolioLocks/'))?.[1];
  assert.equal(lock.active, true);
  assert.equal(s.dispatches, 1);
});


test('provider capture is independently fetched and bound before intent becomes CAPTURED', async () => {
  const s = setup({ getPaymentStatus: async input => ({
    orderId: input.orderId, paymentId: 'pay_123', paymentStatus: 'captured',
    captured: true, amountMinor: 450000, currency: 'INR'
  }) });
  const created = await s.repo.initializePaymentIntent('user_123', payload());
  const reconciled = await s.repo.reconcilePaymentIntent('user_123', created.intentId);
  assert.equal(reconciled.status, 'CAPTURED');
  assert.equal(reconciled.providerPaymentId, 'pay_123');
  assert.equal(reconciled.accountingStatus, 'PENDING');
});

test('capture with mismatched amount or currency is rejected without changing intent state', async () => {
  const s = setup({ getPaymentStatus: async input => ({
    orderId: input.orderId, paymentId: 'pay_bad', paymentStatus: 'captured',
    captured: true, amountMinor: 450001, currency: 'INR'
  }) });
  const created = await s.repo.initializePaymentIntent('user_123', payload());
  await assert.rejects(s.repo.reconcilePaymentIntent('user_123', created.intentId),
    /provider_capture_binding_mismatch/);
  const stored = await s.db.get('paymentIntents/' + created.intentId);
  assert.equal(stored.state, 'CREATED');
});

test('late provider-verified capture supersedes a prior failure but never posts the folio', async () => {
  let status = 'failed';
  const s = setup({ getPaymentStatus: async input => ({
    orderId: input.orderId, paymentId: status === 'captured' ? 'pay_late' : 'pay_failed',
    paymentStatus: status, captured: status === 'captured',
    amountMinor: status === 'captured' ? 450000 : null,
    currency: status === 'captured' ? 'INR' : null
  }) });
  const created = await s.repo.initializePaymentIntent('user_123', payload());
  const failed = await s.repo.reconcilePaymentIntent('user_123', created.intentId);
  assert.equal(failed.status, 'FAILED');
  status = 'captured';
  const late = await s.repo.reconcilePaymentIntent('user_123', created.intentId);
  assert.equal(late.status, 'CAPTURED');
  assert.equal(late.accountingStatus, 'PENDING');
});


test('explicit reconciliation recovers a lost provider-order response without redispatch', async () => {
  const s = setup({
    createOrder: async () => { throw new Error('response_lost_after_provider_create'); },
    findOrderByReference: async ({ reference }) => ({
      found: true, orderId: 'order_recovered_by_reconcile', receipt: reference,
      amountMinor: 450000, currency: 'INR'
    })
  });
  const created = await s.repo.initializePaymentIntent('user_123', payload());
  assert.equal(created.status, 'UNKNOWN');
  const reconciled = await s.repo.reconcilePaymentIntent('user_123', created.intentId);
  assert.equal(reconciled.status, 'CREATED');
  assert.equal(reconciled.providerOrderId, 'order_recovered_by_reconcile');
  assert.equal(s.dispatches, 1);
});


test('PayU checkout is normalized to the exact POST action and signed fields expected by the client', async () => {
  const s = setup({ createOrder: async input => ({
    orderId: input.orderId, amountMinor: input.amountMinor, currency: input.currency,
    checkout: { action:'https://test.payu.in/_payment', method:'POST',
      fields:{ key:'merchant-key', hash:'provider-signed-hash', txnid:input.orderId } }
  }) });
  const result = await s.repo.initializePaymentIntent('user_123', payload({
    provider:'payu', customer:{ firstName:'Guest', email:'guest@example.test' },
    returnUrl:'https://pms.example/payment-return'
  }));
  const stored = await s.repo.getPaymentIntent('user_123', result.intentId);
  assert.equal(stored.state, 'CREATED');
  assert.equal(stored.checkoutData.action, 'https://test.payu.in/_payment');
  assert.equal(stored.checkoutData.method, 'POST');
  assert.equal(stored.checkoutData.fields.hash, 'provider-signed-hash');
});

test('Paytm checkout normalization preserves its hosted checkout origin and token', async () => {
  const s = setup({ createOrder: async input => ({
    orderId: input.orderId, amountMinor: input.amountMinor, currency: input.currency,
    checkout: { mid:'merchant-mid', orderId:input.orderId, txnToken:'provider-token',
      checkoutHost:'https://securestage.paytmpayments.com' }
  }) });
  const result = await s.repo.initializePaymentIntent('user_123', payload({
    provider:'paytm', environment:'staging', customer:{ id:'guest_123' },
    returnUrl:'https://pms.example/payment-return'
  }));
  const stored = await s.repo.getPaymentIntent('user_123', result.intentId);
  assert.equal(stored.state, 'CREATED');
  assert.equal(stored.checkoutData.orderId, stored.providerOrderId);
  assert.equal(stored.checkoutData.txnToken, 'provider-token');
  assert.equal(stored.checkoutData.checkoutHost, 'https://securestage.paytmpayments.com');
});

test('provider checkout response cannot redefine the persisted intent amount', async () => {
  const s = setup({ createOrder: async input => ({
    orderId:input.orderId, amountMinor:input.amountMinor + 1, currency:input.currency,
    keyId:'rzp_test_12345678'
  }) });
  const result = await s.repo.initializePaymentIntent('user_123', payload());
  assert.equal(result.status, 'UNKNOWN');
  const intent = await s.repo.getPaymentIntent('user_123', result.intentId);
  assert.equal(intent.state, 'UNKNOWN');
  assert.equal(intent.checkoutData, undefined);
  assert.equal(s.dispatches, 1);
});
