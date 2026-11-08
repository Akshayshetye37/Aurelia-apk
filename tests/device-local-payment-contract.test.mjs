import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('checkout is fail-closed unless the native engine reports ready', () => {
  const html = read('index.html');
  const start = html.indexOf('window.startAureliaGatewayCheckout=async function');
  const end = html.indexOf('window.reconcileAureliaGatewayPayment=', start);
  assert.ok(start >= 0 && end > start, 'checkout entry point exists');
  const checkout = html.slice(start, end);
  assert.match(checkout, /window\.AndroidPaymentEngine/);
  assert.match(checkout, /typeof engine\.getEngineStatus/);
  assert.match(checkout, /engineStatus\.ready!==true/);
  assert.match(checkout, /livePaymentsEnabled===true/);
  assert.doesNotMatch(checkout, /localGatewayApi\s*\(/);
});

test('every manual folio payment path requires explicit staff receipt confirmation', () => {
  const html = read('index.html');
  const calls = [...html.matchAll(/settlePayment\(\{([\s\S]*?)\}\)/g)].filter(match => /source:'manual'/.test(match[1]));
  assert.ok(calls.length >= 3, 'manual folio payment entry points must be covered');
  for (const call of calls) {
    assert.match(call[0], /verificationConfirmed:true/);
  }
  assert.match(html, /Confirm that you received the money/);
  assert.match(html, /Confirm that payment was actually received/);
});

test('provider directory is synchronized with the wired backend factory and labels test readiness honestly', () => {
  const html = read('index.html');
  const factory = read('payment-backend/src/providers/factory.mjs');
  const registry = read('payment-backend/src/providers/registry.mjs');
  const catalogue = html.match(/PMS_PROVIDER_CATALOGUE\s*=\s*Object\.freeze\(\[([^\]]+)\]\)/);
  const factoryBlock = factory.match(/const FACTORIES = Object\.freeze\(\{([\s\S]*?)\}\);/);
  assert.ok(catalogue, 'frontend provider catalogue exists');
  assert.ok(factoryBlock, 'backend provider factory exists');
  const uiProviders = [...catalogue[1].matchAll(/["']([a-z0-9_]+)["']/g)].map(match => match[1]);
  const allFactoryProviders = [...factoryBlock[1].matchAll(/^[ \t]*([a-z0-9_]+):/gm)].map(match => match[1]);
  // CCAvenue is present as a partial adapter, not one of the six complete adapters
  // exposed by the current checkout catalogue. Do not promote it to checkout-ready.
  const serverProviders = allFactoryProviders.filter(provider => provider !== 'ccavenue');
  assert.deepEqual(uiProviders, serverProviders, 'frontend directory and six complete backend adapters must match');
  assert.ok(allFactoryProviders.includes('ccavenue'), 'CCAvenue partial adapter remains discoverable in the backend factory');
  for (const provider of serverProviders) {
    assert.ok(registry.includes('  ' + provider + ': {'), provider + ' registry entry exists');
  }
  assert.equal(registry.split("adapterStatus: 'adapter_implemented_wired'").length - 1, 6,
    'all six complete adapters must be marked wired in the registry');
  assert.ok(registry.includes('ccavenue: {') && registry.includes("adapterStatus: 'adapter_partial_implemented'"), 'CCAvenue remains explicitly partial');
  assert.match(html, /Server adapter ready \(test\) · Live collection OFF/);
  assert.match(html, /Documentation only/);
  assert.doesNotMatch(html, /Server adapter \(incomplete\)/i);
  assert.match(html, /Hybrid backend is optional\. Local cash and manual payments continue to work from device memory\./);
  assert.match(html, /Live collection remains OFF until the safety gates pass and an authorised tenant administrator enables it in Settings\./);
});


test('merchant credentials are not exposed through WebView or Android local vault UI', () => {
  const html = read('index.html');
  const vault = read('android/templates/LocalGatewayVault.java');
  assert.doesNotMatch(html, /localNativeGatewayHtml|gatewayVaultSave|gatewayVaultRemove|Device-local Gateway Credential Vault/);
  assert.match(html, /Google Secret Manager/);
  assert.match(vault, /merchant_credentials_must_be_managed_by_trusted_backend/);
  assert.match(vault, /purgeLegacyVault\(\)/);
  assert.doesNotMatch(vault, /Cipher\.getInstance|FileOutputStream/);
});

test('Android checkout refuses providers without a completed hosted-checkout handoff before intent creation', () => {
  const html = read('index.html');
  assert.match(html, /Android hosted-checkout handoff is not yet integrated/);
  assert.match(html, /No cloud payment intent was created/);
  assert.match(html, /!\['razorpay','cashfree'\]\.includes\(payload\.provider\)/);
});

test('native payment journal cannot mark a payment posted by status-only mutation', () => {
  const ledger = read('android/templates/LocalPaymentLedger.java');
  assert.match(ledger, /recordVerifiedCapture/);
  assert.match(ledger, /recordAwaitingProvider/);
  assert.doesNotMatch(ledger, /recordFolioPosted\s*\(/);
  assert.match(ledger, /SAFE_PROVIDER_REF/);
  assert.match(ledger, /payment_provider_payment_idx/);
  const androidPatcher = read('scripts/patch-android.js');
  assert.doesNotMatch(androidPatcher, /setAcceptThirdPartyCookies/);
});

test('project documentation preserves the selected hybrid production architecture and release gates', () => {
  const spec = read('docs/DEVICE_LOCAL_PAYMENT_ENGINE_SPEC.md');
  const readme = read('README.md');
  assert.ok(spec.includes('Hybrid Production Architecture (Architecture A)'));
  assert.match(read('docs/HYBRID_PAYMENT_ARCHITECTURE.md'), /publicly reachable HTTPS backend/i);
  assert.match(spec, /Timeout after dispatch is ambiguous/);
  assert.match(readme, /LIVE GATEWAY COLLECTION OFF/);
  assert.match(readme, /Offline cash, manual card-on-delivery and staff-confirmed folio entries remain available/);
  assert.match(readme, /Razorpay[\s\S]*Cashfree[\s\S]*PayU[\s\S]*PhonePe[\s\S]*Paytm[\s\S]*JioPay[\s\S]*CCAvenue/);
});


test('manual folio payment UI commits through the canonical local repository before reporting success', () => {
  const html = read('index.html');
  const settlement = html.slice(html.indexOf('function settlePayment(input)'), html.indexOf('// Legacy unconfirmed addPay shortcut'));
  assert.match(settlement, /input\.source===['"]manual['"]/);
  assert.match(settlement, /AureliaRepositoryCompatibility\?\.settlePayment/);
  assert.doesNotMatch(settlement, /persist\(\);[\s\S]*?return commit/);

  const runtime = html.slice(html.indexOf('id="aurelia-async-runtime-bootstrap"'));
  assert.match(runtime, /repository-settlement-service\.mjs/);
  assert.match(runtime, /settlePayment: input => \{/);
  assert.match(runtime, /settlePaymentToRepository\(\{ \.\.\.input, bridge: storageBridge \}\)/);
  assert.match(runtime, /window\.AureliaLocalOperationalLock\(commit\)/);

  const manualCalls = [...html.matchAll(/(?:await\s+)?settlePayment\(\{[^}]*source:'manual'/g)];
  assert.ok(manualCalls.length >= 4, 'all manual folio payment entry points remain connected');
  for (const call of manualCalls) assert.match(call[0], /^await\s+settlePayment/);
});

test('staff-reviewed UPI approval uses the canonical transaction and cannot mark evidence separately', () => {
  const html = read('index.html');
  const settlement = html.slice(html.indexOf('function settlePayment(input)'), html.indexOf('// Legacy unconfirmed addPay shortcut'));
  assert.match(settlement, /input\.source===['"]staff_review['"]/);
  const start = html.indexOf('async function sigA(');
  const end = html.indexOf('/* money flow */', start);
  assert.ok(start >= 0 && end > start);
  const approve = html.slice(start, end);
  assert.match(approve, /await settlePayment\(/);
  assert.match(approve, /evidenceId:id/);
  assert.doesNotMatch(approve, /s\.st='matched'/);
  assert.doesNotMatch(approve, /persistCanonicalStrict/);
});

test('check-in, check-out and cancellation commit booking, room and snapshot atomically', () => {
  const html = read('index.html');
  const runtime = html.slice(html.indexOf('id="aurelia-async-runtime-bootstrap"'));
  assert.match(runtime, /repository-operational-mutation-service\.mjs/);
  assert.match(runtime, /commitOperationalMutation: input => commitOperationalStateMutation/);
  assert.match(html, /async function commitStayMutation\(/);
  assert.match(html, /await commit\(\{snapshot,bookingId:booking\.id,roomId:String\(room\.n\),eventType\}\)/);

  const checkIns = [...html.matchAll(/async function completeCheckIn\(i\)/g)];
  const checkOuts = [...html.matchAll(/async function completeCheckOut\(i\)/g)];
  assert.equal(checkIns.length, 2, 'both legacy check-in declarations use the async transaction');
  assert.equal(checkOuts.length, 2, 'both legacy check-out declarations use the async transaction');
  assert.match(html, /eventType:'booking\.checked_in'/);
  assert.match(html, /eventType:'booking\.checked_out'/);
  const cancelStart = html.indexOf('async function cxl(i)');
  const cancelEnd = html.indexOf('\nV.stays=', cancelStart);
  assert.ok(cancelStart >= 0 && cancelEnd > cancelStart);
  const cancel = html.slice(cancelStart, cancelEnd);
  assert.match(cancel, /eventType:'booking\.cancelled'/);
  assert.match(cancel, /await commitStayMutation/);
  assert.doesNotMatch(cancel, /persist\(\)/);
});

test('housekeeping room status changes await a canonical room-plus-snapshot transaction', () => {
  const html = read('index.html');
  const runtime = html.slice(html.indexOf('id="aurelia-async-runtime-bootstrap"'));
  assert.match(runtime, /commitRoomStateMutation/);
  assert.match(runtime, /commitRoomMutation: input => commitRoomStateMutation/);
  const start = html.indexOf('async function rs(n,s)');
  const end = html.indexOf('\nfunction tg(', start);
  assert.ok(start >= 0 && end > start);
  const handler = html.slice(start, end);
  assert.match(handler, /await commitRoomStatusMutation/);
  assert.doesNotMatch(handler, /persist\(\)/);
  const helperStart = html.indexOf('async function commitRoomStatusMutation(');
  const helperEnd = html.indexOf('\nlet LOCAL_STATE_STATUS', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  assert.match(html.slice(helperStart, helperEnd), /eventType:'room\.status_changed'/);
});

test('local payment, stay and room mutations share a serialization lock', () => {
  const html = read('index.html');
  assert.match(html, /window\.AureliaLocalOperationalLock=withLocalOperationalLock/);
  const stayStart = html.indexOf('async function commitStayMutation(');
  const stayEnd = html.indexOf('async function commitRoomStatusMutation(', stayStart);
  assert.ok(stayStart >= 0 && stayEnd > stayStart);
  assert.match(html.slice(stayStart, stayEnd), /return withLocalOperationalLock\(async\(\)=>/);
  const roomStart = html.indexOf('async function commitRoomStatusMutation(');
  const roomEnd = html.indexOf('let LOCAL_STATE_STATUS', roomStart);
  assert.match(html.slice(roomStart, roomEnd), /return withLocalOperationalLock\(async\(\)=>/);
  const runtime = html.slice(html.indexOf('id="aurelia-async-runtime-bootstrap"'));
  assert.match(runtime, /window\.AureliaLocalOperationalLock\(commit\)/);
});

test('room creation, editing and retirement use canonical room entities and stable room keys', () => {
  const html = read('index.html');
  const runtime = html.slice(html.indexOf('id="aurelia-async-runtime-bootstrap"'));
  assert.match(runtime, /commitRoomCatalogMutation/);
  assert.match(runtime, /commitRoomCatalogMutation: input => commitRoomCatalogMutation/);
  const saveStart = html.indexOf('async function roomSave(i)');
  const saveEnd = html.indexOf('\nfunction roomS(', saveStart);
  assert.ok(saveStart >= 0 && saveEnd > saveStart);
  const save = html.slice(saveStart, saveEnd);
  assert.match(save, /await commitRoomCatalogState/);
  assert.match(save, /existing\.n!==n/);
  assert.match(save, /immutable rate snapshots/);
  const deleteStart = html.indexOf('async function rdel(i)');
  const deleteEnd = html.indexOf('\n/\* dining and menu \*/', deleteStart);
  assert.ok(deleteStart >= 0 && deleteEnd > deleteStart);
  const remove = html.slice(deleteStart, deleteEnd);
  assert.match(remove, /operation:'remove'/);
  assert.match(remove, /await commitRoomCatalogState/);
  assert.doesNotMatch(remove, /S\.b=S\.b\.filter/);
});

test('guest profile create and edit commit stable guest entities with the canonical snapshot', () => {
  const html = read('index.html');
  const runtime = html.slice(html.indexOf('id="aurelia-async-runtime-bootstrap"'));
  assert.match(runtime, /commitGuestStateMutation/);
  assert.match(runtime, /commitGuestMutation: input => commitGuestStateMutation/);
  const start = html.indexOf('async function gsave()');
  const end = html.indexOf('\nfunction invOp(', start);
  assert.ok(start >= 0 && end > start);
  const handler = html.slice(start, end);
  assert.match(handler, /await commitGuestCatalogState/);
  assert.match(handler, /createStableGuestId/);
  assert.match(handler, /operation:old\?'update':'create'/);
  assert.match(handler, /booking history references it/);
  assert.doesNotMatch(handler, /persist\(\)/);
});

test('primary reservation creation commits guest, booking, folio advance and snapshot in one repository batch', () => {
  const html = read('index.html');
  const runtime = html.slice(html.indexOf('id="aurelia-async-runtime-bootstrap"'));
  assert.match(runtime, /repository-reservation-service\.mjs/);
  assert.match(runtime, /commitReservation: input => commitReservationToRepository/);
  const start = html.indexOf('async function dsave()');
  const end = html.indexOf('\nfunction cin(i)', start);
  assert.ok(start >= 0 && end > start);
  const handler = html.slice(start, end);
  assert.match(handler, /await adapter\.commitReservation\(/);
  assert.match(handler, /folioId:'booking-'/);
  assert.match(handler, /deferPersistence:true/);
  assert.match(handler, /await adapter\.commitGuestMutation\(/);
  assert.doesNotMatch(handler, /persistCanonicalStrict/);
  assert.match(handler, /CRITICAL: Reservation storage read-back failed/);
});

test('final check-in and check-out wrappers await the canonical lifecycle transaction without legacy writes', () => {
  const html = read('index.html');
  const start = html.indexOf('const _completeCheckInFinal=completeCheckIn;');
  const end = html.indexOf('</script>', start);
  assert.ok(start >= 0 && end > start);
  const wrappers = html.slice(start, end);
  assert.match(wrappers, /completeCheckIn=async function\(i\)/);
  assert.match(wrappers, /await _completeCheckInFinal\(i\)/);
  assert.match(wrappers, /completeCheckOut=async function\(i\)/);
  assert.match(wrappers, /await _completeCheckOutFinal\(i\)/);
  assert.doesNotMatch(wrappers, /persist\(\)/);
});
