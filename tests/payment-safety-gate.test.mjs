import test from "node:test";
import assert from "node:assert/strict";
import {
  PAYMENT_SAFETY_LOCKS,
  assertBalanceMutationAllowed,
  assertAutomaticSettlementAllowed,
  assertLiveCollectionAllowed,
  assertNativeBridgeAllowed
} from "../src/payments/payment-safety-gate.mjs";

test("all payment safety controls default to locked", () => {
  assert.deepEqual(PAYMENT_SAFETY_LOCKS, {
    blockAllBalanceMutations: true,
    automaticSettlement: true,
    liveCollection: true,
    nativeSettlementBridge: true
  });
});

test("global balance mutation kill switch rejects manual and automated posting", () => {
  assert.throws(assertBalanceMutationAllowed, { code: "ACCOUNTING_READ_ONLY_KILL_SWITCH" });
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
