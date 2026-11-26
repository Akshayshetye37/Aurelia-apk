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

test('Aurelia PMS shell uses the supplied mobile navigation and local design assets', () => {
  assert.match(html, /aurelia-shell-header/);
  assert.match(html, /AURELIA PMS/);
  assert.match(html, /INR · AURELIA UPI ONLY/);
  assert.match(html, /aurelia-theme-switch/);
  assert.match(html, /aurelia-profile-button/);
  assert.match(html, /aurelia-quick-action primary/);
  assert.match(html, /onclick="go\('upi'\)"/);
  assert.match(html, /Aurelia UPI<\/b>/);
  assert.match(html, /const TABS=\[\['home','Overview'\],\['rooms','Chambers'\],\['stays','Stays'\],\['dining','Dining'\],\['upi','Aurelia UPI'\],\['more','More'\]\]/);
  assert.doesNotMatch(html, /cdn\.tailwindcss\.com|fonts\.googleapis\.com|fonts\.gstatic\.com/);
});

test('Aurelia PMS shell theme is packaged locally without external font or CSS runtime', async () => {
  const theme = await readFile(new URL('../assets/aurelia-sovereign-theme.css', import.meta.url), 'utf8');
  assert.match(theme, /--gold:#f7d387/);
  assert.match(theme, /--em:#68dbad/);
  assert.match(theme, /grid-template-columns:repeat\(6,minmax\(0,1fr\)\)/);
  assert.match(theme, /body\[data-theme="light"\]/);
});

test('New booking action tracks the real dock edge without double-counting safe area', () => {
  assert.match(html, /function positionBookingAction\(\)/);
  assert.match(html, /window\.innerHeight\|\|document\.documentElement\.clientHeight/);
  assert.match(html, /new ResizeObserver\(positionBookingAction\)/);
  assert.match(html, /new MutationObserver\(observeDock\)/);
  assert.match(html, /--aurelia-booking-bottom/);
  assert.equal(html.includes('bottom:var(--aurelia-booking-bottom,148px) + env(safe-area-inset-bottom'), false);
  assert.equal(html.includes('#hor-book{bottom:var(--aurelia-booking-bottom,148px)!important}'), true);
});


test('Aurelia dashboard identity replaces the legacy homestay defaults in every initializer', () => {
  assert.match(html, /set:\{name:'Aurelia PMS',tag:'Property management, thoughtfully connected\.'/);
  assert.match(html, /S\.set=\{name:'Aurelia PMS',tag:'Property management, thoughtfully connected\.'/);
  assert.match(html, /set:\{name:'Aurelia PMS',phone:/);
  assert.doesNotMatch(html, /Hari Om Retreat|hariom@upi/i);
});

test('dashboard greeting and header clock share India/device time and refresh on resume', () => {
  assert.match(html, /function aureliaIndiaClock\(now=new Date\(\)\)/);
  assert.match(html, /Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone/);
  assert.match(html, /'Asia\/Kolkata'/);
  assert.match(html, /h=aureliaIndiaClock\(\)\.hour/);
  assert.match(html, /id="aurelia-dashboard-greeting"/);
  assert.match(html, /clock\.title='Time zone: '\+time\.timeZone/);
  assert.match(html, /setInterval\(tickClock,15000\)/);
  assert.match(html, /document\.addEventListener\('visibilitychange'/);
  assert.match(html, /window\.addEventListener\('focus',tickClock\)/);
});

test('PMS startup does not mutate non-existent demo bookings, guests or dining tables', () => {
  assert.equal(html.includes('S.t[2].demo=1'), false);
  assert.equal(html.includes('S.b[1].pays='), false);
  assert.equal(html.includes('214000+i*7919'), false);
});

test('reference workspace design adds desktop sidebar navigation without replacing the PMS router', () => {
  assert.match(html, /aurelia-design-sidebar/);
  assert.match(html, /aurelia-design-nav/);
  assert.match(html, /data-aurelia-tab/);
  assert.match(html, /if\(typeof go==='function'\)go\(button\.dataset\.aureliaTab\)/);
  assert.match(html, /const TABS=\[\['home','Overview'\],\['rooms','Chambers'\],\['stays','Stays'\],\['dining','Dining'\],\['upi','Aurelia UPI'\],\['more','More'\]\]/);
  assert.match(html, /id="aurelia-design-new"/);
  assert.match(html, /const clock=app\.querySelector\('#aurelia-shell-clock'\),?actions=app\.querySelector\('\.aurelia-header-actions'\)/);
  assert.match(html, /if\(typeof resv==='function'\)resv\(\)/);
});

test('reference workspace keeps six-destination mobile dock and responsive desktop-to-mobile transition', () => {
  assert.match(html, /\.aurelia-design-shell\{display:flex;min-height:100vh;width:100%\}/);
  assert.match(html, /\.aurelia-design-sidebar\{/);
  assert.match(html, /@media\(max-width:900px\)[\s\S]*?\.aurelia-design-sidebar\{display:none\}/);
  assert.match(html, /@media\(max-width:900px\)[\s\S]*?\.dock\{display:grid\}/);
  assert.match(html, /grid-template-columns:repeat\(6,minmax\(0,1fr\)\)/);
  assert.match(html, /#hor-book\{display:none!important\}/);
  assert.match(html, /#hor-book\{display:flex!important\}/);
});

test('reference workspace applies emerald and champagne-gold visual tokens without weakening offline font policy', () => {
  assert.match(html, /--bg:#07120e;--s1:#0c1d16;--s2:#10241c/);
  assert.match(html, /--gold:#dfc07b/);
  assert.match(html, /--serif:"Cormorant Garamond",Georgia,serif/);
  assert.match(html, /--sans:Inter,system-ui,-apple-system,"Segoe UI",sans-serif/);
  assert.doesNotMatch(html, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
  assert.match(html, /Content-Security-Policy/);
});

test('reference workspace preserves PMS app boot, local persistence and critical operations modules', () => {
  assert.match(html, /function render\(\)/);
  assert.match(html, /function loadAll\(\)/);
  assert.match(html, /function persist\(\)/);
  assert.match(html, /aurelia-persistence-and-stay-extension/);
  assert.match(html, /aurelia-upi-integration/);
  assert.match(html, /aurelia-modern-operations/);
  assert.match(html, /aurelia-thermal-receipt/);
  assert.match(html, /scripts\/stay-extension\.js/);
});
