import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('all application sections are reachable from one accessible dropdown', () => {
  assert.match(html, /id=["']aurelia-section-menu["']/);
  assert.match(html, /aria-label=["']Navigate to application section["']/);
  assert.match(html, /TL\.map|sectionEntries/);
  assert.match(html, /new Set\(/);
});

test('thermal receipts have independent 80 mm and 58 mm paper profiles', () => {
  assert.match(html, /aureliaPrintThermalReceipt/);
  assert.match(html, /size:\s*\$\{?width\}?mm\s+200mm/i);
  assert.match(html, /value=["']80["']/);
  assert.match(html, /value=["']58["']/);
  assert.match(html, /thermal-receipt/);
});

test('A4 document printing remains separate from thermal receipt printing', () => {
  assert.match(html, /printGuestPreview/);
  assert.match(html, /aurelia-thermal-print/);
  assert.match(html, /aureliaPrintThermalReceipt/);
});

test('legacy direct checkout cannot bypass explicit UPI receipt confirmation', () => {
  assert.match(html, /aurelia-upi-settlement-guard/);
  assert.match(html, /Record and confirm the Aurelia UPI payment before check-out/);
  assert.match(html, /AureliaPaymentPolicy/);
});

test('Aurelia payment policy remains UPI-only with no payment gateways', () => {
  assert.match(html, /enabledMethods:\s*Object\.freeze\(\['UPI'\]\)/);
  assert.match(html, /providerGatewaysEnabled:\s*false/);
});
