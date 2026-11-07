import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const vault = await readFile(new URL('../android/templates/LocalGatewayVault.java', import.meta.url), 'utf8');
const patch = await readFile(new URL('../scripts/patch-android.js', import.meta.url), 'utf8');

test('retired device-local merchant credential storage is purged and cannot be reused', () => {
  assert.ok(vault.includes('purgeLegacyVault()'));
  assert.ok(vault.includes('store.deleteEntry(KEY_ALIAS)'));
  assert.ok(vault.includes('merchant_credentials_must_be_managed_by_trusted_backend'));
  assert.ok(!vault.includes('Cipher.getInstance'));
  assert.ok(!vault.includes('KeyGenerator.getInstance'));
  assert.ok(!vault.includes('FileOutputStream'));
  assert.ok(html.includes('Google Secret Manager'));
});

test('native credential bridge fails closed and provider directory supports six backend adapters', () => {
  for (const provider of ['razorpay','cashfree','payu','phonepe','paytm','jiopay']) {
    assert.ok(html.includes(provider), 'missing provider: ' + provider);
  }
  assert.ok(!html.includes('gatewayVaultSave'));
  assert.ok(!html.includes('gatewayVaultRemove'));
  assert.ok(!html.includes('local-gw-'));
  assert.ok(html.includes('Optional trusted HTTPS backend'));
  assert.ok(vault.includes('BACKEND_ONLY'));
});

test('legacy LAN backend code is not used as the checkout fallback', () => {
  const start = html.indexOf('window.startAureliaGatewayCheckout=async function');
  const end = html.indexOf('window.reconcileAureliaGatewayPayment=', start);
  const checkout = html.slice(start, end);
  assert.ok(checkout.includes('window.AndroidPaymentEngine'));
  assert.ok(checkout.includes('engineStatus.ready!==true'));
  assert.ok(!checkout.includes('localGatewayApi('));
  assert.ok(!patch.includes('setAcceptThirdPartyCookies'));
});


test('provider directory accurately reports all six wired non-live adapters and CCAvenue documentation-only status', () => {
  for (const provider of ['Razorpay','Cashfree Payments','PayU','PhonePe','Paytm','JioPay']) {
    assert.ok(html.includes(provider), 'missing provider directory entry: ' + provider);
  }
  assert.ok(html.includes('Server adapter ready (test) · Live collection OFF'));
  assert.ok(html.includes('CCAvenue'));
  assert.ok(html.includes('Documentation only'));
  assert.ok(html.includes('CCAvenue is not included in the active provider factory'));
  assert.ok(!html.includes('Backend adapter not implemented · documentation only'));
});

test('Payment Gateway messaging preserves offline-first operation and backend-only secrets', () => {
  assert.ok(html.includes('Hybrid backend is optional. Local cash and manual payments continue to work from device memory.'));
  assert.ok(html.includes('Merchant credentials and webhook secrets stay in Google Secret Manager'));
  assert.ok(html.includes('Provider checkout callbacks are UI signals only'));
  assert.ok(html.includes('Live collection OFF · release gate enforced'));
});


test('tenant live-collection switch is server-backed, double-gated and MFA protected', () => {
  assert.ok(html.includes('refreshAureliaLiveCollectionControl'));
  assert.ok(html.includes('initializeAureliaPaymentControls'));
  assert.ok(html.includes('live_collection_enabled'));
  assert.ok(html.includes('recent MFA'));
  assert.ok(html.includes('signInAureliaPaymentAdmin'));
  assert.ok(html.includes('signOutAureliaPaymentAdmin'));
  assert.ok(html.includes('aurelia-payment-admin-password'));
  assert.ok(html.includes('Select your enrolled MFA method'));
  assert.ok(html.includes('/v1/admin/payment-controls'));
  assert.ok(html.includes('internal release gate'));
});

test('CCAvenue remains the only provider excluded from the Android checkout path', () => {
  assert.ok(html.includes('Android hosted-checkout handoff is not yet integrated'));
  assert.ok(html.includes('No cloud payment intent was created.'));
  assert.ok(!html.includes('PayU is not yet available in the Android checkout handoff.'));
  assert.ok(html.includes('CCAvenue'));
});
