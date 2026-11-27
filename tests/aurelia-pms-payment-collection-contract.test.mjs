import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readIndex = () => readFile(new URL('../index.html', import.meta.url), 'utf8');

test('guest checkout shows the folio balance and routes UPI collection into the Aurelia session desk', async () => {
  const html = await readIndex();
  assert.match(html, /Guest Check-Out/);
  assert.match(html, /Folio total/);
  assert.match(html, /Payments received/);
  assert.match(html, /Balance due/);
  assert.match(html, /checkout-method/);
  assert.match(html, /Create Aurelia UPI Request/);
  assert.match(html, /openAureliaUpiForFolio/);
});

test('every open room folio offers UPI and cash collection in the single Folios payment workspace', async () => {
  const app = await readFile(new URL('../src/aurelia-upi/app.mjs', import.meta.url), 'utf8');
  const html = await readIndex();
  assert.match(html, /id="aurelia-upi-root"/);
  assert.match(app, /data-upi-action="collect-folio"/);
  assert.match(app, /data-upi-action="cash-folio"/);
  assert.match(app, /Open balances ready to collect/);
});

test('every open dining ticket offers UPI and cash collection in the single Folios payment workspace', async () => {
  const app = await readFile(new URL('../src/aurelia-upi/app.mjs', import.meta.url), 'utf8');
  const html = await readIndex();
  assert.match(html, /id="aurelia-upi-root"/);
  assert.match(app, /data-upi-action="collect-dining"/);
  assert.match(app, /data-upi-action="cash-dining"/);
});

test('cash and bank payments require explicit receipt confirmation and are bounded by the open balance', async () => {
  const html = await readIndex();
  assert.match(html, /Confirm that the cash or bank payment was actually received/);
  assert.match(html, /amount > due \+ 0\.009/);
  assert.match(html, /I confirm the payment was actually received/);
  assert.match(html, /Bank reference <small>\(Optional\)<\/small>/);
});

test('UPI reconciliation retains optional UTR and mandatory bank-credit verification', async () => {
  const app = await readFile(new URL('../src/aurelia-upi/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /Enter UTR if available/);
  assert.match(app, /Confirm that you checked the credit in the receiving bank account/);
  assert.match(app, /if \(utr && !\//);
});

test('WhatsApp sharing is provided by Aurelia UPI for both WhatsApp Personal and Business handlers', async () => {
  const app = await readFile(new URL('../src/aurelia-upi/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /https:\/\/wa\.me\//);
  assert.match(app, /data-upi-action="whatsapp"/);
  assert.match(app, /guestPhone/);
  assert.doesNotMatch(app, /package=com\\.whatsapp(?:\\.w4b)?/);
});

test('payment rails exclude card/POS and external gateways', async () => {
  const html = await readIndex();
  assert.match(html, /providerGatewaysEnabled: false/);
  assert.match(html, /enabledMethods: Object\.freeze\(\["AURELIA_UPI", "CASH", "BANK_TRANSFER"\]\)/);
  assert.doesNotMatch(html, /value="card"|data-method="CARD"|POS terminal integration/);
});
