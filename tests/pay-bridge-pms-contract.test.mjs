import test from "node:test";
import assert from "node:assert/strict";
import {
  isPayBridgeAuthenticated,
  hasPayBridgeCapability
} from "../src/payments/provider-platform.mjs";

const connected = {
  authenticated: true,
  packageName: "com.aurelia.paybridge",
  protocolVersion: 1,
  certificateSha256: "a".repeat(64),
  capabilities: ["handshake", "provider.management"]
};

test("accepts only a fully authenticated protocol-v1 Pay Bridge connection", () => {
  assert.equal(isPayBridgeAuthenticated(connected), true);
  assert.equal(isPayBridgeAuthenticated({...connected, protocolVersion: 2}), false);
  assert.equal(isPayBridgeAuthenticated({...connected, packageName: "untrusted.app"}), false);
  assert.equal(isPayBridgeAuthenticated({...connected, certificateSha256: "bad"}), false);
  assert.equal(isPayBridgeAuthenticated({...connected, capabilities: []}), false);
  assert.equal(isPayBridgeAuthenticated({...connected, authenticated: false}), false);
});

test("provider management requires its explicit negotiated capability", () => {
  assert.equal(hasPayBridgeCapability(connected, "provider.management"), true);
  assert.equal(hasPayBridgeCapability(connected, "payment.create"), false);
  assert.equal(hasPayBridgeCapability({...connected, capabilities: ["handshake"]}, "provider.management"), false);
  assert.equal(hasPayBridgeCapability(connected, ""), false);
  assert.equal(hasPayBridgeCapability(null, "provider.management"), false);
});

test("does not infer payment operations from provider management", () => {
  assert.equal(hasPayBridgeCapability(connected, "payment.create"), false);
  assert.equal(hasPayBridgeCapability(connected, "refund.create"), false);
});
