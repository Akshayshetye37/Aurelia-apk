import test from 'node:test';
import assert from 'node:assert/strict';
import { scanOverdueRefunds } from '../src/refunds/review-scan.mjs';
import { REFUND_STATES, createRefundRecord, transitionRefund } from '../src/refunds/refund-state-machine.mjs';

const NOW = Date.parse('2026-11-15T12:00:00.000Z');
function record(id, confirmedAt, state = REFUND_STATES.PROVIDER_CONFIRMED) {
  const created = createRefundRecord({
    refundId: id, intentId: 'intent_' + id, tenantId: 'tenant_123',
    provider: 'razorpay', providerAccountId: 'acct_123', environment: 'test',
    providerOrderId: 'order_' + id, providerPaymentId: 'pay_' + id,
    originalAmountMinor: 10000, amountMinor: 1000,
    idempotencyKey: 'idem_' + id, requestedBy: 'owner_requester',
    now: () => new Date(NOW - 60 * 60 * 1000).toISOString()
  });
  const approved = transitionRefund(created, {
    eventId: 'approve_' + id, type: 'approve', payload: { approvedBy: 'different_owner' }
  }, { now: () => new Date(NOW - 55 * 60 * 1000).toISOString() }).record;
  const pending = transitionRefund(approved, {
    eventId: 'dispatch_' + id, type: 'provider_dispatch_started'
  }, { now: () => new Date(NOW - 50 * 60 * 1000).toISOString() }).record;
  const confirmed = transitionRefund(pending, {
    eventId: 'confirm_' + id, type: 'provider_confirmed',
    payload: { evidence: {
      verified: true, provider: 'razorpay', providerOrderId: 'order_' + id,
      providerPaymentId: 'pay_' + id, amountMinor: 1000, currency: 'INR',
      providerRefundId: 'provider_refund_' + id, status: 'processed'
    } }
  }, { now: () => confirmedAt }).record;
  return { ...confirmed, state };
}
function fakeDb(records) {
  const payments = new Map(records.map(item => [item.refundId, structuredClone(item)]));
  const alerts = new Map();
  const makeRef = (collection, id) => ({ collection, id });
  const db = {
    collection(name) {
      return {
        where(field, op, value) {
          assert.equal(name, 'paymentRefunds');
          assert.equal(field, 'state'); assert.equal(op, '==');
          return query(value, null);
        },
        doc(id) { return makeRef(name, id); }
      };
    },
    async runTransaction(fn) {
      const staged = [];
      const tx = {
        async get(ref) {
          const map = ref.collection === 'paymentRefunds' ? payments : alerts;
          const value = map.get(ref.id);
          return { exists: !!value, data: () => value && structuredClone(value) };
        },
        update(ref, value) { staged.push(() => Object.assign(payments.get(ref.id), value)); },
        create(ref, value) { staged.push(() => alerts.set(ref.id, structuredClone(value))); }
      };
      const result = await fn(tx);
      staged.forEach(apply => apply());
      return result;
    },
    payments, alerts
  };
  function query(state, after) {
    return {
      orderBy() { return this; },
      limit(limit) { this.pageSize = limit; return this; },
      startAfter(doc) { this.after = doc.id; return this; },
      async get() {
        const rows = [...payments.entries()].filter(([, value]) => value.state === state)
          .sort(([a], [b]) => a.localeCompare(b))
          .filter(([id]) => !this.after || id > this.after)
          .slice(0, this.pageSize)
          .map(([id, value]) => ({ id, ref: makeRef('paymentRefunds', id), data: () => structuredClone(value) }));
        return { docs: rows, empty: rows.length === 0 };
      }
    };
  }
  return db;
}

test('scheduled scanner promotes overdue refunds and creates one durable alert without ledger mutation', async () => {
  const overdue = record('rf_overdue', new Date(NOW - 31 * 60 * 1000).toISOString());
  const recent = record('rf_recent', new Date(NOW - 5 * 60 * 1000).toISOString());
  const db = fakeDb([overdue, recent]);
  const events = [];
  const result = await scanOverdueRefunds({
    db, now: () => new Date(NOW), pageSize: 1, onAlert: event => events.push(event)
  });
  assert.equal(result.scanned, 2);
  assert.equal(result.promoted, 1);
  assert.equal(result.alertsCreated, 1);
  assert.equal(events[0].severity, 'ALERT');
  assert.equal(db.payments.get('rf_overdue').state, REFUND_STATES.HUMAN_REVIEW);
  assert.equal(db.payments.get('rf_recent').state, REFUND_STATES.PROVIDER_CONFIRMED);
  assert.equal(db.alerts.get('rf_overdue').reason, 'PROVIDER_CONFIRMED_LOCAL_REVERSAL_MISSING');
  assert.equal(db.payments.get('rf_overdue').localReversalEntryId, undefined);
});

test('repeated scheduled scans are idempotent and do not duplicate alerts', async () => {
  const db = fakeDb([record('rf_once', new Date(NOW - 45 * 60 * 1000).toISOString())]);
  let emitted = 0;
  const options = { db, now: () => new Date(NOW), onAlert: () => emitted++ };
  const first = await scanOverdueRefunds(options);
  const second = await scanOverdueRefunds(options);
  assert.equal(first.promoted, 1);
  assert.equal(second.promoted, 0);
  assert.equal(second.alertsCreated, 0);
  assert.equal(emitted, 1);
  assert.equal(db.alerts.size, 1);
});

test('scanner rejects invalid configuration and does not auto-correct provider-confirmed refunds', async () => {
  const db = fakeDb([record('rf_manual', new Date(NOW - 90 * 60 * 1000).toISOString())]);
  await assert.rejects(scanOverdueRefunds({ db, pageSize: 501 }), /refund_review_scan_configuration_invalid/);
  const result = await scanOverdueRefunds({ db, now: () => new Date(NOW) });
  assert.equal(result.promoted, 1);
  assert.equal(db.payments.get('rf_manual').state, REFUND_STATES.HUMAN_REVIEW);
  assert.equal(db.payments.get('rf_manual').localReversalEntryId, undefined);
});
