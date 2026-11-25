import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('Aurelia UPI is a first-class app destination, not a settings-section dropdown', () => {
  assert.match(html, /\['upi','Aurelia UPI'\]/);
  assert.match(html, /V\.upi\s*=/);
  assert.match(html, /AureliaUPI\.render/);
  assert.doesNotMatch(html, /aurelia-section-menu|installSectionMenu/);
});

test('thermal receipts have independent 80 mm and 58 mm paper profiles', () => {
  assert.match(html, /aureliaPrintThermalReceipt/);
  assert.match(html, /size:'\+width\+'mm 200mm/i);
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
  assert.match(html, /Verify and post the Aurelia UPI payment before checkout/);
  assert.match(html, /Only manually verified Aurelia UPI payments can be posted/);
  assert.match(html, /AureliaPaymentPolicy/);
});

test('Aurelia payment policy remains UPI-only with no payment gateways', () => {
  assert.match(html, /enabledMethods:Object\.freeze\(\['AURELIA_UPI'\]\)/);
  assert.match(html, /automaticSettlement:false/);
  assert.match(html, /notificationEvidenceCanSettle:false/);
  assert.match(html, /providerGatewaysEnabled:\s*false/);
});

test('Aurelia UPI QR generation is local and does not call a hosted QR service', () => {
  assert.match(html, /data-aurelia-upi-qr/);
  assert.doesNotMatch(html, /api\.qrserver\.com/);
  assert.match(html, /\.\/assets\/qrcode\.min\.js/);
  assert.match(html, /\.\/src\/aurelia-upi\/app\.mjs/);
});

test('legacy payment signals are review-only and cannot auto-post a folio payment', () => {
  assert.match(html, /function addSig\(o\)/);
  assert.match(html, /function sigA\(id,i\).*AureliaUPI\.importSignal/);
  assert.match(html, /Only manually verified Aurelia UPI payments can be posted/);
  assert.doesNotMatch(html, /addPay\(p,s\.amt,'UPI',[^;]*true\)/);
});

test('Aurelia UPI uses one configured VPA and no demo receiving address', () => {
  assert.match(html, /Aurelia UPI ID \(VPA\)/);
  assert.doesNotMatch(html, /hariom@upi/);
});

test('Sovereign shell uses the supplied mobile navigation and a local-only asset policy', () => {
  assert.match(html, /aurelia-shell-header/);
  assert.match(html, /AURELIA LOCAL NODE/);
  assert.match(html, /INR · AURELIA UPI ONLY/);
  assert.match(html, /aurelia-theme-switch/);
  assert.match(html, /aurelia-profile-button/);
  assert.match(html, /const TABS=\[\['home','Overview'\],\['rooms','Chambers'\],\['stays','Stays'\],\['dining','Dining'\],\['more','Vault'\],\['upi','Aurelia UPI'\]\]/);
  assert.doesNotMatch(html, /cdn\.tailwindcss\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net/);
});

test('Sovereign shell theme is packaged locally without external font or CSS runtime', async () => {
  const theme = await readFile(new URL('../assets/aurelia-sovereign-theme.css', import.meta.url), 'utf8');
  assert.match(theme, /--gold:#f7d387/);
  assert.match(theme, /--em:#68dbad/);
  assert.match(theme, /grid-template-columns:repeat\(6,minmax\(0,1fr\)\)/);
  assert.match(theme, /body\[data-theme="light"\]/);
});
