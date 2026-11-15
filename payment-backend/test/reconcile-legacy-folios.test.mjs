import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileLegacySnapshots } from '../scripts/reconcile-legacy-folios.mjs';

const local = () => ({
  folios: [{ tenantId: 'tenant_1', folioId: 'folio_1', currency: 'INR', balanceMinor: 75000 }],
  entries: [{
    intentId: 'intent_1', tenantId: 'tenant_1', folioId: 'folio_1',
    providerPaymentId: 'pay_1', amountMinor: 25000, currency: 'INR',
    type: 'PAYMENT_CREDIT'
  }]
});

test('read-only reconciliation reports exact match without modifying either snapshot', () => {
  const localSnapshot = local();
  const firestoreSnapshot = structuredClone(localSnapshot);
  const beforeLocal = structuredClone(localSnapshot);
  const beforeFirestore = structuredClone(firestoreSnapshot);
  const result = reconcileLegacySnapshots(localSnapshot, firestoreSnapshot);
  assert.equal(result.status, 'MATCH');
  assert.equal(result.counts.mismatches, 0);
  assert.deepEqual(localSnapshot, beforeLocal);
  assert.deepEqual(firestoreSnapshot, beforeFirestore);
});

test('reconciliation reports balance and journal mismatches without attempting repairs', () => {
  const localSnapshot = local();
  const firestoreSnapshot = local();
  firestoreSnapshot.folios[0].balanceMinor = 70000;
  firestoreSnapshot.entries[0].providerPaymentId = 'pay_other';
  const result = reconcileLegacySnapshots(localSnapshot, firestoreSnapshot);
  assert.equal(result.status, 'REVIEW_REQUIRED');
  assert.deepEqual(result.mismatches.map(item => item.type).sort(),
    ['FOLIO_BALANCE_MISMATCH', 'JOURNAL_ENTRY_MISMATCH']);
  assert.equal(firestoreSnapshot.folios[0].balanceMinor, 70000);
  assert.equal(firestoreSnapshot.entries[0].providerPaymentId, 'pay_other');
});

test('reconciliation rejects ambiguous duplicate folio or journal identities', () => {
  const duplicateFolio = local();
  duplicateFolio.folios.push({ ...duplicateFolio.folios[0] });
  assert.throws(() => reconcileLegacySnapshots(duplicateFolio, local()), /local_duplicate_folio/);
  const duplicateEntry = local();
  duplicateEntry.entries.push({ ...duplicateEntry.entries[0] });
  assert.throws(() => reconcileLegacySnapshots(duplicateEntry, local()), /local_duplicate_intent_entry/);
});
