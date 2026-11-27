import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readIndex = () => readFile(new URL('../index.html', import.meta.url), 'utf8');

test('guest checkout exposes balance, cash collection and the Aurelia UPI session QR/share flow', async () => {
  const html = await readIndex();
  assert.match(html, /Guest Check-Out/);
  assert.match(html, /Folio total/);
  assert.match(html, /Payments received/);
  assert.match(html, /Balance due/);
  assert.match(html, /recordFolioCash\(/);
  assert.match(html, /I confirm this cash amount was physically received/);
  assert.match(html, /openAureliaUpiForFolio\(/);
  assert.match(html, /Show QR & Share Payment Link/);
});

test('dining settlement offers cash and a shareable Aurelia UPI session', async () => {
  const html = await readIndex();
  assert.match(html, /data-pay="Cash" onclick="selectRestPay/);
  assert.match(html, /Create shareable Aurelia UPI request/);
  assert.match(html, /function selectRestPay\(method\)/);
  assert.match(html, /function recordRestPay\(\)/);
  assert.match(html, /if\(p\.method==='UPI'&&!document\.getElementById\('rest-pay-confirm'\)\?\.checked\)/);
  assert.match(html, /enabledMethods:Object\.freeze\(\['AURELIA_UPI','CASH'\]\)/);
});

test('cash and UPI remain the only supported collection methods; no card or gateway rail is enabled', async () => {
  const html = await readIndex();
  assert.match(html, /providerGatewaysEnabled:false/);
  assert.doesNotMatch(html, /enabledMethods:Object\.freeze\(\[[^\]]*CARD/);
});
