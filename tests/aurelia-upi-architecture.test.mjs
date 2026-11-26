import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  AURELIA_UPI_POLICY,
  SESSION_STATUS,
  createPaymentSession,
  enqueueSession,
  transitionSession
} from '../src/aurelia-upi/domain.mjs';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('Aurelia UPI keeps a single direct rail and disables observer-driven settlement', () => {
  assert.deepEqual(AURELIA_UPI_POLICY.enabledRails, ['AURELIA_UPI']);
  assert.equal(AURELIA_UPI_POLICY.externalPaymentGateways, false);
  assert.equal(AURELIA_UPI_POLICY.automaticSettlement, false);
  assert.equal(AURELIA_UPI_POLICY.notificationEvidenceCanSettle, false);
});

test('session confirmation cannot bypass explicit manual bank verification', () => {
  const now = Date.parse('2026-11-26T10:00:00.000Z');
  const session = createPaymentSession({
    id: 'architecture-test',
    vpa: 'aurelia@okaxis',
    amountPaise: 49900,
    payeeName: 'Aurelia',
    reference: 'AUR-ARCH-001'
  }, now);
  const active = enqueueSession([], session, { nowMs: now })[0];
  const review = transitionSession(active, SESSION_STATUS.REVIEW_REQUIRED, {}, now + 1000);
  assert.throws(
    () => transitionSession(review, SESSION_STATUS.CONFIRMED, { confirmedBy: 'OBSERVER' }, now + 2000),
    /explicit operator verification/
  );
  const confirmed = transitionSession(review, SESSION_STATUS.CONFIRMED, {
    manualVerified: true,
    confirmedBy: 'LOCAL_OPERATOR'
  }, now + 2000);
  assert.equal(confirmed.status, SESSION_STATUS.CONFIRMED);
  assert.equal(confirmed.manualVerified, true);
});

test('incoming evidence import and customer claims remain review-only', async () => {
  const app = await read('src/aurelia-upi/app.mjs');
  const importEvidence = app.slice(app.indexOf('async function importEvidence'), app.indexOf('async function assignEvidence'));
  const markPaid = app.slice(app.indexOf('async function markCustomerReportedPaid'), app.indexOf('async function cancelSession'));
  assert.match(importEvidence, /SESSION_STATUS\.REVIEW_REQUIRED/);
  assert.doesNotMatch(importEvidence, /SESSION_STATUS\.CONFIRMED/);
  assert.match(markPaid, /customer_claim_only/);
  assert.match(markPaid, /no payment has been settled/i);
  assert.doesNotMatch(markPaid, /claimReference|savePayment/);
});

test('payment confirmation requires local operator verification, a bank reference and native encrypted storage', async () => {
  const app = await read('src/aurelia-upi/app.mjs');
  const confirm = app.slice(app.indexOf('async function confirmEvidence'), app.indexOf('async function rejectEvidence'));
  assert.match(confirm, /receiving bank account/);
  assert.match(confirm, /if \(!repository\.isNative\)/);
  assert.match(confirm, /A bank UTR\/reference is required/);
  assert.match(confirm, /await repository\.claimReference\(utr, "PAYMENT"/);
  assert.match(confirm, /manualVerified: true/);
  assert.match(confirm, /CONFIRMED_PENDING_PMS/);
});

test('queue keeps unresolved review and pending PMS posting sessions from releasing their VPA', async () => {
  const domain = await read('src/aurelia-upi/domain.mjs');
  const app = await read('src/aurelia-upi/app.mjs');
  assert.match(domain, /"ACTIVE", "PROCESSING", "OBSERVED", "REVIEW_REQUIRED"/);
  assert.match(app, /pendingSessionIds/);
  assert.match(app, /pendingVpas/);
  assert.match(app, /Do not promote another request until the posting saga is complete/);
});

test('architecture decision record rejects gateway-only and observer-quorum settlement claims', async () => {
  const doc = await read('docs/AURELIA_UPI_ARCHITECTURE_REVIEW.md');
  assert.match(doc, /HMAC proves that a payload was produced/);
  assert.match(doc, /No L1\/L2\/L3 tier can transition a session to confirmed/);
  assert.match(doc, /Baileys \/ WhatsApp OTP/);
  assert.match(doc, /Cash on delivery, cash counter, card counter/);
  assert.match(doc, /SQLCipher canonical-store cutover/);
});
