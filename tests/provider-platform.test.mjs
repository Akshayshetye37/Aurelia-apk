import test from "node:test";
import assert from "node:assert/strict";
import { PAYMENT_PROVIDERS, validateProviderConfig, normalizeProviderEvent, isPayBridgeAuthenticated } from "../src/payments/provider-platform.mjs";

test("provider registry exposes modular provider definitions", () => {
  assert.ok(PAYMENT_PROVIDERS.razorpay);
  assert.ok(PAYMENT_PROVIDERS.cashfree);
  assert.ok(PAYMENT_PROVIDERS.payu);
  assert.ok(PAYMENT_PROVIDERS.phonepe);
});

test("provider config requires HTTPS backend and public merchant identifier", () => {
  assert.throws(() => validateProviderConfig("razorpay", { keyId: "rzp_test_1", backendUrl: "http://example.test" }), /HTTPS/);
  assert.throws(() => validateProviderConfig("razorpay", { backendUrl: "https://api.example.test" }), /keyId/);
  assert.deepEqual(validateProviderConfig("razorpay", { keyId: "rzp_test_1", backendUrl: "https://api.example.test" }), {
    provider: "razorpay", keyId: "rzp_test_1", backendUrl: "https://api.example.test"
  });
});

test("client refuses provider secret fields", () => {
  assert.throws(() => validateProviderConfig("razorpay", { keyId: "rzp_test_1", backendUrl: "https://api.example.test", keySecret: "do-not-store" }), /trusted backend/);
});

test("normalizes provider events without treating unverified callbacks as verified", () => {
  const event = normalizeProviderEvent("cashfree", {
    providerTransactionId: "cf-123", merchantReference: "AUR-BOOK-1",
    amount: 1250, currency: "inr", method: "UPI", status: "SUCCESS"
  });
  assert.equal(event.status, "paid");
  assert.equal(event.verified, false);
  assert.equal(event.currency, "INR");
});

test("Pay Bridge connection requires package identity and certificate fingerprint", () => {
  assert.equal(isPayBridgeAuthenticated({ authenticated: true, packageName: "com.aurelia.paybridge", certificateSha256: "a".repeat(64) }), true);
  assert.equal(isPayBridgeAuthenticated({ authenticated: true, packageName: "com.other.app", certificateSha256: "a".repeat(64) }), false);
  assert.equal(isPayBridgeAuthenticated({ authenticated: true, packageName: "com.aurelia.paybridge" }), false);
});
