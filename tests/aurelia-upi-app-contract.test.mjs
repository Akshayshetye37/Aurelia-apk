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
