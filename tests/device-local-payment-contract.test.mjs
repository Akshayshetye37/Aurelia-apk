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

test('device credential vault contains all seven agreed providers', () => {
  const html = read('index.html');
  const vaultStart = html.indexOf('function localNativeGatewayHtml()');
  const vaultEnd = html.indexOf('window.saveAureliaNativeGateway=', vaultStart);
  assert.ok(vaultStart >= 0 && vaultEnd > vaultStart, 'native vault renderer exists');
  const vault = html.slice(vaultStart, vaultEnd);
  for (const provider of ['razorpay', 'cashfree', 'payu', 'phonepe', 'paytm', 'ccavenue', 'jiopay']) {
    assert.match(vault, new RegExp(provider));
  }
  assert.match(vault, /Android Keystore/);
  assert.match(vault, /does not validate provider keys/);
  assert.match(vault, /phonepe:\['uat','production'\]/);
  assert.match(vault, /paytm:\['staging','production'\]/);
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
  assert.match(spec, /Exactly-once network delivery is not promised/);
  assert.match(readme, /NOT READY FOR LIVE PAYMENT COLLECTION/);
  assert.match(readme, /Razorpay[\s\S]*Cashfree[\s\S]*PayU[\s\S]*PhonePe[\s\S]*Paytm[\s\S]*JioPay[\s\S]*CCAvenue/);
});
