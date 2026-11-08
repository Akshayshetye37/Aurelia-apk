import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(path, 'utf8');

test('Android native checkout uses the immutable release safeguard before SDK handoff', () => {
  const patcher = read('scripts/patch-android.js');
  const safeguard = read('android/templates/security/PaymentReleaseSafeguards.kt');
  const call = patcher.indexOf('PaymentReleaseSafeguards.assertSandboxCheckoutAllowed(provider, environment)');
  const order = patcher.indexOf('String orderId = obj.optString("providerOrderId", "");', call);
  assert.ok(call >= 0, 'native checkout invokes the safeguard');
  assert.ok(order > call, 'safeguard executes before provider order and SDK dispatch');
  assert.match(patcher, /'PaymentReleaseSafeguards\.kt'/);
  assert.match(safeguard, /private const val LIVE_GATEWAY_COLLECTION = false/);
  assert.match(safeguard, /private const val AUTOMATIC_SETTLEMENT = false/);
  assert.match(safeguard, /private const val AUTOMATIC_REFUND_POSTING = false/);
});

test('Android release safeguard permits only sandbox environments for the six wired providers', () => {
  const source = read('android/templates/security/PaymentReleaseSafeguards.kt');
  for (const [provider, environment] of [
    ['razorpay', 'test'], ['cashfree', 'test'], ['payu', 'test'],
    ['phonepe', 'test'], ['paytm', 'staging'], ['jiopay', 'uat']
  ]) {
    assert.match(source, new RegExp('"' + provider + '" to PaymentImplementationStatus\\.SANDBOX_ONLY'));
    assert.ok(source.includes('"' + provider + '"'));
    assert.ok(source.includes('"' + environment + '"'));
  }
  assert.match(source, /"ccavenue" to PaymentImplementationStatus\.NOT_IMPLEMENTED/);
  assert.match(source, /production_payment_environment_blocked_on_device/);
});

test('Android safeguards cannot authorize settlement or refund posting', () => {
  const source = read('android/templates/security/PaymentReleaseSafeguards.kt');
  assert.match(source, /fun isAutomaticSettlementAllowed\(\): Boolean = AUTOMATIC_SETTLEMENT/);
  assert.match(source, /fun isAutomaticRefundPostingAllowed\(\): Boolean = AUTOMATIC_REFUND_POSTING/);
  assert.match(source, /fun isLiveCollectionAllowed\(\): Boolean = LIVE_GATEWAY_COLLECTION/);
});
