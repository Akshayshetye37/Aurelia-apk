import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = () => readFile(new URL('../index.html', import.meta.url), 'utf8');

test('main PMS uses the uploaded Aurelia workspace rather than the previous main-branch shell', async () => {
  const source = await html();
  assert.match(source, /Aurelia PMS — Boutique Property Management Workspace/);
  assert.match(source, /function createDefaultState\(\)/);
  assert.match(source, /function openCheckoutModal\(bookingId\)/);
  assert.match(source, /function openManualFolioPaymentModal\(bookingId\)/);
  assert.match(source, /function openManualDiningPaymentModal\(tableId\)/);
  assert.match(source, /function loadState\(\)/);
  assert.match(source, /SAVE BLOCKED — existing device data could not be read safely/);
  assert.match(source, /function openInvoiceModal\(id\)/);
  assert.match(source, /function completeCheckout\(bookingId\)/);
});

test('uploaded PMS shell connects to the repository Aurelia UPI module and encrypted native payment repository', async () => {
  const source = await html();
  assert.match(source, /href="\.\/assets\/aurelia-upi\.css"/);
  assert.match(source, /src="\.\/assets\/qrcode\.min\.js"/);
  assert.match(source, /src="\.\/src\/aurelia-upi\/app\.mjs"/);
  assert.match(source, /window\.AureliaPmsContext = \{/);
  assert.match(source, /applyFolioPayment: async \(session, utr\)/);
  assert.match(source, /applyRestaurantPayment: async \(session, utr\)/);
  assert.match(source, /aureliaUpiSessionId: session\.id/);
  assert.match(source, /persistMutation\(\)/);
  assert.match(source, /legacyUpiView\(\)/);
});

test('checkout makes exact-amount UPI QR and guest sharing action explicit while preserving cash and bank transfer', async () => {
  const source = await html();
  assert.match(source, /Generate UPI QR &amp; Share Payment Link/);
  assert.match(source, /upi: "Aurelia UPI: generate the exact-amount QR/);
  assert.match(source, /<option value="cash">Cash<\/option>/);
  assert.match(source, /<option value="bank">Bank Transfer<\/option>/);
  assert.match(source, /Send Payment Link on WhatsApp/);
  assert.match(source, /function recordCheckoutPayment\(bookingId\)/);
});

test('every open folio and dining balance exposes a cash/bank collection action', async () => {
  const source = await html();
  assert.match(source, /data-action="upi-cash-folio"/);
  assert.match(source, /data-action="upi-cash-table"/);
  assert.match(source, /function recordManualFolioPayment\(bookingId\)/);
  assert.match(source, /function recordManualDiningPayment\(tableId\)/);
  assert.match(source, /Cash: confirm the amount received at the front desk/);
});

test('legacy alert suggestions require exact amount and exact guest name; no amount-only auto-assignment', async () => {
  const source = await html();
  assert.match(source, /const exactMatches = payerKey \? active\.filter\(s => Math\.abs\(s\.amount - al\.amount\) < 0\.01 && String\(s\.guestName/);
  assert.match(source, /A candidate requires both the exact amount and exact guest name/);
});
