import test from "node:test";
import assert from "node:assert/strict";
import {
  PAYMENT_SAFETY_LOCKS,
  assertBalanceMutationAllowed,
  assertAutomaticSettlementAllowed,
  assertLiveCollectionAllowed,
  assertNativeBridgeAllowed,
  assertOnlineGatewayAllowed,
  assertPayBridgeAllowed
} from "../src/payments/payment-safety-gate.mjs";

test("offline manual folio mutations are available while gateway paths remain locked", () => {
  assert.deepEqual(PAYMENT_SAFETY_LOCKS, {
    blockAllBalanceMutations: false,
    automaticSettlement: true,
    liveCollection: true,
    nativeSettlementBridge: true,
    onlineGatewayPayments: false,
    payBridge: false,
    cloudSync: false,
    uiCutover: false,
    ccavenue: false,
    enabledProviders: []
  });
  assert.doesNotThrow(assertBalanceMutationAllowed);
});

test("automatic settlement remains blocked", () => {
  assert.throws(assertAutomaticSettlementAllowed, { code: "AUTO_SETTLEMENT_KILL_SWITCH" });
});

test("live collection remains blocked", () => {
  assert.throws(assertLiveCollectionAllowed, { code: "LIVE_COLLECTION_KILL_SWITCH" });
});

test("native settlement bridge remains blocked", () => {
  assert.throws(assertNativeBridgeAllowed, { code: "NATIVE_SETTLEMENT_BRIDGE_KILL_SWITCH" });
});

test("local-only release keeps every optional network/payment path disabled", () => {
  assert.equal(PAYMENT_SAFETY_LOCKS.uiCutover, false);
  assert.equal(PAYMENT_SAFETY_LOCKS.cloudSync, false);
  assert.equal(PAYMENT_SAFETY_LOCKS.onlineGatewayPayments, false);
  assert.equal(PAYMENT_SAFETY_LOCKS.payBridge, false);
  assert.equal(PAYMENT_SAFETY_LOCKS.ccavenue, false);
  assert.deepEqual(PAYMENT_SAFETY_LOCKS.enabledProviders, []);
  assert.throws(assertOnlineGatewayAllowed, { code: "ONLINE_GATEWAY_DISABLED" });
  assert.throws(assertPayBridgeAllowed, { code: "PAY_BRIDGE_DISABLED" });
});
