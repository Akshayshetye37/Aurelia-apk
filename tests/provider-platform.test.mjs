import test from "node:test";
import assert from "node:assert/strict";
import { PAYMENT_PROVIDERS, PMS_PROVIDER_CATALOGUE, PROVIDER_INTEGRATION_GUIDES, validateProviderConfig, getSingleConfiguredProvider, normalizeProviderEvent, isPayBridgeAuthenticated } from "../src/payments/provider-platform.mjs";

test("provider registry exposes modular provider definitions", () => {
  assert.ok(PAYMENT_PROVIDERS.razorpay);
  assert.ok(PAYMENT_PROVIDERS.cashfree);
  assert.ok(PAYMENT_PROVIDERS.payu);
  assert.ok(PAYMENT_PROVIDERS.phonepe);
  assert.ok(PAYMENT_PROVIDERS.paytm);
  assert.ok(PAYMENT_PROVIDERS.jiopay);
  assert.ok(PAYMENT_PROVIDERS.ccavenue);
  assert.deepEqual(PMS_PROVIDER_CATALOGUE, ["razorpay", "cashfree", "payu", "phonepe", "paytm", "jiopay", "ccavenue"]);
});

test("provider config requires HTTPS backend and public merchant identifier", () => {
  assert.throws(() => validateProviderConfig("razorpay", { keyId: "rzp_test_1", backendUrl: "http://example.test" }), /HTTPS/);
  assert.throws(() => validateProviderConfig("razorpay", { backendUrl: "https://api.example.test" }), /Key ID/);
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

test("Razorpay, Paytm and PhonePe have provider-specific official integration workspaces", () => {
  for (const id of ["razorpay", "paytm", "phonepe"]) {
    const provider = PAYMENT_PROVIDERS[id];
    const guide = PROVIDER_INTEGRATION_GUIDES[id];
    assert.ok(provider, id + " provider registry entry missing");
    assert.ok(guide && guide.flow.length >= 3, id + " integration guide missing");
    assert.ok(guide.docs.length >= 2, id + " official documentation links missing");
    assert.ok(guide.docs.every(link => link.url.startsWith("https://")), id + " docs must use HTTPS");
  }
  assert.match(PROVIDER_INTEGRATION_GUIDES.razorpay.successState, /captured/i);
  assert.match(PROVIDER_INTEGRATION_GUIDES.paytm.successState, /checksum|status server-side/i);
  assert.match(PROVIDER_INTEGRATION_GUIDES.phonepe.successState, /independently fetch order status/i);
});

test("Paytm final success state is normalized but remains unverified until backend confirms it", () => {
  const event = normalizeProviderEvent("paytm", {
    providerTransactionId: "paytm-txn-1", merchantReference: "AUR-FOLIO-1",
    amount: 1250, currency: "INR", status: "TXN_SUCCESS"
  });
  assert.equal(event.status, "paid");
  assert.equal(event.verified, false);
});

test("India provider catalogue covers aggregators and direct bank gateways", () => {
  for (const id of ["razorpay", "cashfree", "payu", "phonepe", "paytm", "jiopay", "ccavenue", "billdesk", "easebuzz", "atom", "zaakpay", "instamojo", "hdfc_smartgateway", "sbi_epay", "axis_pg", "icici_pg", "pine_labs"]) {
    assert.ok(PAYMENT_PROVIDERS[id], id + " catalogue entry missing");
    assert.ok(PAYMENT_PROVIDERS[id].docs.every(link => link.url.startsWith("https://")), id + " docs must use HTTPS");
    assert.ok(PAYMENT_PROVIDERS[id].identityField, id + " merchant identifier field missing");
  }
});

test("single-provider selection replaces previous provider and reads legacy settings safely", () => {
  assert.equal(getSingleConfiguredProvider({}), null);
  assert.equal(getSingleConfiguredProvider({ razorpay: { configured: true } }), "razorpay");
  assert.equal(getSingleConfiguredProvider({
    razorpay: { configured: true }, paytm: { configured: true }
  }), "razorpay");
  assert.deepEqual(Object.keys({ payu: { configured: true } }), ["payu"]);
});
