import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const vault = await readFile(new URL('../android/templates/LocalGatewayVault.java', import.meta.url), 'utf8');
const patch = await readFile(new URL('../scripts/patch-android.js', import.meta.url), 'utf8');

test('PMS presents the device-local vault and does not render the retired LAN owner console', () => {
  assert.ok(html.includes('Device-local Gateway Credential Vault'));
  assert.ok(html.includes('Device-local Gateway Credential Vault'));
  assert.ok(!html.includes(">'+localGatewayAdminHtml()+'"));
  assert.ok(html.includes('No LAN or Docker payment appliance is used.'));
});

test('native credential administration supports only the six wired provider schema catalogue', () => {
  for (const provider of ['razorpay','cashfree','payu','phonepe','paytm','jiopay']) {
    assert.ok(html.includes(provider), 'missing provider: ' + provider);
    assert.ok(vault.includes('"'+provider+'".equals(provider)'), 'native vault missing provider: ' + provider);
  }
  assert.ok(!vault.includes('"ccavenue".equals(provider)'));
  assert.ok(html.includes('gatewayVaultSave'));
  assert.ok(html.includes('gatewayVaultStatus'));
  assert.ok(html.includes('gatewayVaultRemove'));
});

test('production credential storage and activation remain blocked', () => {
  assert.ok(vault.includes('live_credential_storage_blocked_until_release_acceptance'));
  assert.ok(vault.includes('live_activation_blocked_until_production_lifecycle_is_certified'));
  assert.ok(html.includes('Production credential entry and storage are disabled.'));
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
