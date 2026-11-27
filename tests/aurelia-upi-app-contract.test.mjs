import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('Aurelia UPI reconciliation revalidates exact amount, UTR uniqueness and operator attestation', async () => {
  const app = await read('src/aurelia-upi/app.mjs');
  assert.match(app, /Number\(evidence\.amountPaise\) !== Number\(session\.amountPaise\)/);
  assert.match(app, /Confirm that you checked the credit in the receiving bank account/);
  assert.match(app, /This UTR is already linked to another Aurelia UPI payment/);
  assert.match(app, /CONFIRMED_PENDING_PMS/);
  assert.match(app, /retryPendingPosting/);
  assert.match(app, /AURELIA_UPI_PAYMENT_APPLIED/);
});

test('refund reservations count prior obligations and prevent duplicate transfer UTRs', async () => {
  const app = await read('src/aurelia-upi/app.mjs');
  const domain = await read('src/aurelia-upi/domain.mjs');
  assert.match(app, /alreadyRefundedPaise/);
  assert.match(app, /row\.paymentId === payment\.id/);
  assert.match(app, /refund transfer UTR is already recorded/);
  assert.match(domain, /amount \+ alreadyRefunded > captured/);
});

test('reconciliation recovery is idempotent when native review or PMS posting partially commits', async () => {
  const app = await read('src/aurelia-upi/app.mjs');
  const repository = await read('android/templates/LocalPmsRepository.java');
  assert.match(app, /alreadyApplied/);
  assert.match(app, /alreadyConfirmed/);
  assert.match(app, /Retry PMS posting/);
  assert.match(repository, /if\(status\.equals\(current\)\)/);
});

test('uploaded checkout and dining payment entry points route to the project Aurelia UPI module', async () => {
  const html = await read('index.html');
  assert.match(html, /window\.openAureliaUpiForFolio\(b\.id, amount\)/);
  assert.match(html, /window\.openAureliaUpiForDining/);
  assert.match(html, /AureliaUPI\.openCollection/);
  assert.match(html, /AureliaUPI\.render\(window\.AureliaPmsContext\)/);
  assert.doesNotMatch(html, /createUpiSession\(\{ kind: "folio"/);
});

test('project PMS adapter posts verified folio and dining payments idempotently', async () => {
  const html = await read('index.html');
  assert.match(html, /applyFolioPayment: async \(session, utr\)/);
  assert.match(html, /AURELIA-UPI:/);
  assert.match(html, /payment\.sessionId === session\.id/);
  assert.match(html, /applyRestaurantPayment: async \(session, utr\)/);
  assert.match(html, /aureliaUpiSessionId: session\.id/);
  assert.match(html, /The verified Aurelia UPI payment remains pending posting/);
});

test('bank statement import stores normalized UPI rows as evidence without retaining the uploaded file', async () => {
  const app = await read('src/aurelia-upi/app.mjs');
  const domain = await read('src/aurelia-upi/domain.mjs');
  assert.match(app, /Import bank statement CSV/);
  assert.match(app, /file\.text\(\)/);
  assert.match(app, /new FileReader\(\)/);
  assert.match(app, /AURELIA_UPI_BANK_STATEMENT_IMPORTED/);
  assert.match(app, /The original file is not retained/);
  assert.match(domain, /export function parseBankStatementCsv/);
  assert.match(domain, /source: "BANK_STATEMENT_CSV"/);
});

test('verified payment keeps its FIFO slot until PMS posting and session finalization complete', async () => {
  const app = await read('src/aurelia-upi/app.mjs');
  const refresh = app.slice(app.indexOf('async function refreshData'), app.indexOf('async function ensureLoaded'));
  assert.match(refresh, /pendingSessionIds/);
  assert.match(refresh, /pendingVpas\.has\(receivingVpa\)/);
  const confirm = app.slice(app.indexOf('async function confirmEvidence'), app.indexOf('async function retryPendingPosting'));
  assert.ok(confirm.indexOf('saveSession(reviewSession') < confirm.indexOf('applyFolioPayment'));
  assert.ok(confirm.indexOf('applyFolioPayment') < confirm.indexOf('saveSession(confirmedSession'));
  const retry = app.slice(app.indexOf('async function retryPendingPosting'), app.indexOf('async function rejectEvidence'));
  assert.match(retry, /payment\.manualVerified !== true/);
  assert.match(retry, /AURELIA_UPI_PAYMENT_CONFIRMATION_RECOVERED/);
  assert.match(retry, /AURELIA_UPI_QUEUE_PROMOTED/);
});

test('collection submission and payment review actions reject concurrent duplicate taps', async () => {
  const app = await read('src/aurelia-upi/app.mjs');
  assert.match(app, /const actionLocks = new Set\(\)/);
  assert.match(app, /if \(actionLocks\.has\(lockKey\)\) return/);
  assert.match(app, /if \(collectionInFlight\) return/);
});

test('open room and dining balances expose cash/bank actions next to the Aurelia UPI request action', async () => {
  const html = await read('index.html');
  assert.match(html, /data-action="upi-create-folio"/);
  assert.match(html, /data-action="folio-manual-payment"/);
  assert.match(html, /data-action="upi-create-table"/);
  assert.match(html, /data-action="upi-cash-table"/);
  assert.match(html, /function openManualDiningPaymentModal/);
});

test('receiving VPA changes fail closed until encrypted payment history is loaded and open sessions are resolved', async () => {
  const html = await read('index.html');
  assert.match(html, /Enter a valid UPI ID/);
  assert.match(html, /installed Aurelia Android app after encrypted payment storage is available/);
  assert.match(html, /Resolve all active and queued Aurelia UPI requests/);
});

test('WhatsApp sharing uses a universal wa.me URL and supports saved guest phone numbers', async () => {
  const app = await read('src/aurelia-upi/app.mjs');
  const html = await read('index.html');
  const domain = await read('src/aurelia-upi/domain.mjs');
  assert.match(app, /data-upi-action="whatsapp"/);
  assert.match(app, /https:\/\/wa\.me\//);
  assert.match(app, /session\.upiUri/);
  assert.match(app, /guestPhone/);
  assert.match(app, /Exact amount due:/);
  assert.match(html, /guestPhone: getGuest\(booking\.g\)\?\.ph/);
  assert.match(domain, /guestPhone: \(\(\) => \{/);
  assert.match(domain, /String\(input\.guestPhone \?\? ""\)/);
  assert.doesNotMatch(app, /package=com\\.whatsapp(?:\\.w4b)?/);
});

test('Aurelia UPI UTR is optional while receiving-bank confirmation remains mandatory', async () => {
  const app = await read('src/aurelia-upi/app.mjs');
  const reviewStart = app.indexOf('function renderReviewCard');
  const reviewEnd = app.indexOf('function renderReview()', reviewStart);
  const review = app.slice(reviewStart, reviewEnd);
  const confirm = app.slice(app.indexOf('async function confirmEvidence'), app.indexOf('async function retryPendingPosting'));
  assert.match(review, /Enter UTR if available/);
  assert.match(confirm, /Confirm that you checked the credit in the receiving bank account/);
  assert.match(confirm, /if \(utr && !\//);
});

test('notification matching only proposes uniquely timed exact-amount named guest folios', async () => {
  const domain = await read('src/aurelia-upi/domain.mjs');
  assert.match(domain, /session\.kind !== "folio"/);
  assert.match(domain, /session\.bookingId == null/);
  assert.match(domain, /session\.amountPaise !== evidence\.amountPaise/);
  assert.match(domain, /candidates\.length > 1/);
});


test('Aurelia UPI shares a guest-owned payment link and never launches the operator phone UPI app', async () => {
  const app = await read('src/aurelia-upi/app.mjs');
  assert.match(app, /data-upi-action="copy-link"/);
  assert.match(app, /async function copySessionPaymentLink\(/);
  assert.match(app, /Send exact-amount link to guest on WhatsApp/);
  assert.doesNotMatch(app, /data-upi-action="open"/);
  assert.doesNotMatch(app, /Open UPI app/);
});
