import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_FIRESTORE_SETTLEMENT_ENABLED,
  settleVerifiedPaymentIntent
} from '../src/intents/folio-settlement.mjs';

test('legacy Firestore folio settlement remains present for audit but hard-disabled', async () => {
  let transactions = 0;
  const db = { runTransaction: async () => { transactions++; } };
  assert.equal(LEGACY_FIRESTORE_SETTLEMENT_ENABLED, false);
  await assert.rejects(settleVerifiedPaymentIntent({
    db, intentId: '123e4567-e89b-42d3-a456-426614174000',
    eventId: 'event_123', providerPaymentId: 'pay_123'
  }), /legacy_firestore_settlement_disabled/);
  assert.equal(transactions, 0);
});
