import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ledger = readFileSync(new URL('../android/templates/LocalPaymentLedger.java', import.meta.url), 'utf8');
const patch = readFileSync(new URL('../scripts/patch-android.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const docs = readFileSync(new URL('../docs/LOCAL_FIRST_HYBRID_PAYMENT_ARCHITECTURE.md', import.meta.url), 'utf8');

test('native payment journal is durable and idempotent', () => {
  assert.match(ledger, /extends SQLiteOpenHelper/);
  assert.match(ledger, /insertWithOnConflict/);
  assert.match(ledger, /payment_ledger_idempotency_conflict/);
  assert.match(ledger, /amount_minor INTEGER NOT NULL CHECK\(amount_minor > 0\)/);
});

test('local journal cannot claim provider capture or mark cloud sync complete', () => {
  assert.match(ledger, /SAVED_ON_DEVICE/);
  assert.match(ledger, /RECONCILIATION_REQUIRED/);
  assert.doesNotMatch(ledger, /CAPTURED|PAYMENT_SUCCESS|markCloudSynced|setCloudSyncStatus/);
  assert.doesNotMatch(ledger, /cloud_sync_status.*SYNCED.*UPDATE/i);
});

test('native bridge is generated and reports journal errors', () => {
  assert.match(patch, /LocalPaymentLedger\.java/);
  assert.match(patch, /paymentLedgerCreate/);
  assert.match(patch, /paymentLedgerListPending/);
  assert.match(patch, /paymentLedgerUpdateLocalStatus/);
  assert.match(patch, /aureliaNativeLedgerResult/);
});

test('web runtime exposes the native journal without storing credentials in browser storage', () => {
  assert.match(html, /window\.AureliaLocalPaymentLedger/);
  assert.match(html, /paymentLedgerCreate/);
  assert.match(html, /paymentLedgerListPending/);
});

test('hybrid architecture documents HTTPS-only LAN and server-authoritative payment status', () => {
  assert.match(docs, /usesCleartextTraffic=false/);
  assert.match(docs, /must not set SYNCED/);
  assert.match(docs, /not a complete payment flow/);
});

test('offline intent UI validates paise and clearly avoids claiming collection', () => {
  assert.match(html, /createAureliaLocalPaymentIntent/);
  assert.match(html, /Math\.round\(amount\*100\)/);
  assert.match(html, /No payment has been initiated or collected/);
  assert.match(html, /does not create a provider order, open checkout, collect money or mark a folio paid/);
  assert.match(html, /refreshAureliaLocalPaymentJournal/);
});
