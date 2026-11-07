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
  const serverProviders = [...factoryBlock[1].matchAll(/^\s*([a-z0-9_]+):/gm)].map(match => match[1]);
  assert.deepEqual(uiProviders, serverProviders, 'frontend directory and backend factory must have the same six providers');
  for (const provider of serverProviders) {
    assert.match(registry, new RegExp('^\\s*' + provider + ':\\s*\\{', 'm'), provider + ' registry entry exists');
  }
  assert.equal((registry.match(/adapterStatus:\s*'adapter_implemented_wired'/g) || []).length, 6,
    'all six factory providers must be marked wired in the registry');
  assert.match(registry, /ccavenue:[\s\S]*?adapterStatus:\s*'not_implemented'/);
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
  assert.match(html, /!\['razorpay','cashfree','phonepe','jiopay','paytm'\]\.includes\(payload\.provider\)/);
});

test('PhonePe, JioPay and Paytm use native checkout handoff and return only reconciliation hints', () => {
  const html = read('index.html');
  const androidPatcher = read('scripts/patch-android.js');
  const bridge = read('src/payments/payment-device-bridge.mjs');
  assert.match(html, /'phonepe','jiopay','paytm'/);
  assert.match(html, /aurelia-hosted-provider-details/);\n  assert.match(html, /aurelia-paytm-details/);
  assert.match(androidPatcher, /"phonepe".equals\(provider\) \|\| "jiopay".equals\(provider\)/);
  assert.match(androidPatcher, /checkoutUri.getScheme\(\)/);
  assert.match(androidPatcher, /HOSTED_CHECKOUT_RETURNED/);
  assert.match(bridge, /"phonepe", "jiopay", "paytm"/);
  assert.match(bridge, /aureliaNativePaymentEvent/);
  assert.match(html, /Live collection remains OFF/);
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
