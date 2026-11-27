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

test('reconciliation recovery is idempotent when a prior native review or PMS post partially committed', async () => {
  const app = await read('src/aurelia-upi/app.mjs');
  const repository = await read('android/templates/LocalPmsRepository.java');
  assert.match(app, /alreadyApplied/);
  assert.match(app, /alreadyConfirmed/);
  assert.match(app, /Retry PMS posting/);
  assert.match(repository, /if\(status\.equals\(current\)\)/);
});

test('legacy invoice and dining settlement entry points cannot bypass Aurelia UPI collection sessions', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /A payment QR is created only after an Aurelia UPI collection slot is allocated/);
  assert.match(html, /Create Aurelia UPI collection/);
  assert.match(html, /if\(window\.__aureliaUpiApplying\)return originalDiningSettle\.apply/);
  assert.match(html, /window\.openAureliaUpiForDining\(\);return false/);
  assert.match(html, /Record payments through the Aurelia UPI review desk/);
  assert.match(html, /Post restaurant payments through the Aurelia UPI review desk/);
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

test('restaurant settlement sheet exposes Aurelia UPI only', async () => {
  const html = await read('index.html');
  const start = html.indexOf("window.__restPay={table:Number(t.n),amount,method:'UPI'}");
  const end = html.indexOf('function selectRestPay(method)', start);
  assert.ok(start >= 0 && end > start);
  const sheet = html.slice(start, end);
  assert.match(sheet, /data-pay="UPI"/);
  assert.match(sheet, /Aurelia UPI/);
  assert.doesNotMatch(sheet, /data-pay="Cash"|Cash/);
});


test('VPA changes validate the address and fail closed until encrypted payment history is loaded', async () => {
  const html = await read('index.html');
  assert.match(html, /Enter a valid Aurelia UPI ID in name@bank format/);
  assert.match(html, /!upiState\?\.loaded\|\|upiState\?\.storageError/);
  assert.match(html, /Resolve all active and queued Aurelia UPI requests before changing the receiving VPA/);
});

test('successful folio and restaurant posting close the legacy overlay before returning to Aurelia UPI', async () => {
  const html = await read('index.html');
  assert.match(html, /The PMS folio did not accept the payment[\s\S]{0,260}closeS\(\)/);
  assert.match(html, /aureliaUpiSessionId=session\.id;\}[\s\S]{0,120}closeS\(\)/);
});

test('active exact-amount Aurelia UPI requests can be addressed to the guest through WhatsApp without pinning an app variant', async () => {
  const app = await read('src/aurelia-upi/app.mjs');
  const html = await read('index.html');
  const domain = await read('src/aurelia-upi/domain.mjs');
  assert.match(app, /data-upi-action="whatsapp"/);
  assert.match(app, /https:\/\/wa\.me\//);
  assert.match(app, /session\.upiUri/);
  assert.match(app, /guestPhone/);
  assert.match(app, /Exact amount due:/);
  assert.match(html, /guestPhone:\(S\.g\|\|\[\]\)\.find/);
  assert.match(domain, /guestPhone: safeText\(input\.guestPhone/);
  assert.match(domain, /"guestName", "guestPhone", "room"/);
  assert.doesNotMatch(app, /package=com\\.whatsapp(?:\\.w4b)?/);
});

test('Aurelia UPI UTR is optional while receiving-bank confirmation remains mandatory', async () => {
  const app = await read('src/aurelia-upi/app.mjs');
  const review = app.slice(app.indexOf('function renderReviewCard'), app.indexOf('function renderReview'));
  const confirm = app.slice(app.indexOf('async function confirmEvidence'), app.indexOf('async function retryPendingPosting'));
  assert.match(review, /Enter UTR if available/);
  assert.match(confirm, /Confirm that you checked the credit in the receiving bank account/);
  assert.match(confirm, /if \(utr && !\//);
});
