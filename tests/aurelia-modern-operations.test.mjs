import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const upi = await readFile(new URL('../src/aurelia-upi/app.mjs', import.meta.url), 'utf8');
const domain = await readFile(new URL('../src/aurelia-upi/domain.mjs', import.meta.url), 'utf8');

test('uploaded PMS Folios destination mounts the project Aurelia UPI payment desk', () => {
  assert.match(html, /MOBILE_TABS/);
  assert.match(html, /\["upi", "Folios"/);
  assert.match(html, /window\.AureliaUPI \? window\.AureliaUPI\.render\(window\.AureliaPmsContext\)/);
  assert.match(html, /id="aurelia-upi-root"/);
});

test('checkout and invoice collection use an exact-amount UPI session rather than a static untracked QR', () => {
  assert.match(html, /function recordCheckoutPayment\(bookingId\)/);
  assert.match(html, /window\.openAureliaUpiForFolio\(b\.id, amount\)/);
  assert.match(html, /Create Aurelia UPI Request/);
  assert.match(html, /Create Aurelia UPI QR & Guest Payment Request/);
  assert.match(upi, /createPaymentSession/);
});

test('UPI payment posting requires explicit receiving-bank verification and cannot auto-settle from alerts', () => {
  assert.match(upi, /Confirm that you checked the credit in the receiving bank account/);
  assert.match(upi, /manualVerified: true/);
  assert.match(domain, /notificationEvidenceCanSettle: false/);
  assert.match(domain, /session\.kind !== "folio"/);
  assert.match(domain, /session\.amountPaise !== evidence\.amountPaise/);
});

test('all PMS collection methods remain available without POS or card acquiring', () => {
  assert.match(html, /<option value="upi">Aurelia UPI/);
  assert.match(html, /<option value="cash">Cash/);
  assert.match(html, /<option value="bank">Bank Transfer/);
  assert.match(html, /Cash \/ Bank/);
  assert.match(html, /upi-cash-table/);
  assert.match(html, /providerGatewaysEnabled: false/);
  assert.doesNotMatch(html, /data-method="CARD"|value="card"|value=\\"card\\"/);
});

test('thermal receipts and A4 invoices remain separate document workflows', () => {
  assert.match(html, /function openThermalModal/);
  assert.match(html, /thermal-paper/);
  assert.match(html, /function openInvoiceModal/);
  assert.match(html, /data-action="print-now"/);
});

test('incoming alerts are routed into review evidence and never posted automatically', () => {
  assert.match(upi, /async function importSignal/);
  assert.match(upi, /async function confirmEvidence/);
  assert.match(domain, /notificationEvidenceCanSettle: false/);
  assert.match(html, /importLegacyUpiAlerts/);
});

test('VPA changes fail closed until encrypted payment history is loaded and open sessions are resolved', () => {
  assert.match(html, /installed Aurelia Android app after encrypted payment storage is available/);
  assert.match(html, /Resolve all active and queued Aurelia UPI requests/);
  assert.match(html, /Enter a valid UPI ID/);
});

test('local QR and UPI assets are bundled without a hosted QR or chart dependency', () => {
  assert.match(html, /\.\/assets\/qrcode\.min\.js/);
  assert.match(html, /\.\/src\/aurelia-upi\/app\.mjs/);
  assert.match(html, /\.\/assets\/aurelia-upi\.css/);
  assert.doesNotMatch(html, /api\.qrserver\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com/);
});

test('legacy main-branch state is migrated without deleting the original source record', () => {
  assert.match(html, /function migrateLegacyProjectState\(value\)/);
  assert.match(html, /aurelia_lodge_v2/);
  assert.match(html, /LEGACY-MIGRATION-/);
  assert.match(html, /legacyInventoryLedger/);
  assert.doesNotMatch(html, /removeItem\("aurelia_lodge_v2"\)/);
});


test('changing the receiving VPA refreshes and verifies native encrypted UPI storage before saving', async () => {
  const save = html.slice(html.indexOf('if (act === "save-settings")'), html.indexOf('if (act === "save-rest-settings")'));
  assert.match(save, /await upiModule\.refresh\(\)/);
  assert.match(save, /upiModule\.isNativeStorageAvailable\(\)/);
  assert.match(save, /upiState\?\.storageError/);
  assert.match(save, /hasOpenUpiRequests/);
  assert.match(save, /await persistMutation\(\)/);
  assert.match(save, /HTML preview changes are not saved/);
});

test('Folios renders one shared payment workspace and does not duplicate the open-balance panel', () => {
  const folios = html.slice(html.indexOf('upi() {'), html.indexOf('guests() {'));
  assert.match(folios, /id="aurelia-upi-root"/);
  assert.doesNotMatch(folios, /Open Balances Ready to Collect/);
  assert.doesNotMatch(folios, /const folioRows/);
});

test('UPI workspace inherits the PMS content width and card surfaces', async () => {
  const css = await readFile(new URL('../assets/aurelia-upi.css', import.meta.url), 'utf8');
  assert.match(css, /\.au-shell\{[^}]*width:100%;max-width:none/);
  assert.match(css, /\.pms-upi-content\{width:100%;min-width:0\}/);
  assert.match(css, /background:var\(--bg-card\)/);
});
