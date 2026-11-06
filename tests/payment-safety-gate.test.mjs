import test from "node:test";
import assert from "node:assert/strict";
import {
  PAYMENT_SAFETY_LOCKS,
  assertBalanceMutationAllowed,
  assertAutomaticSettlementAllowed,
  assertLiveCollectionAllowed,
  assertNativeBridgeAllowed
} from "../src/payments/payment-safety-gate.mjs";

test("offline manual folio mutations are available while gateway paths remain locked", () => {
  assert.deepEqual(PAYMENT_SAFETY_LOCKS, {
    blockAllBalanceMutations: false,
    automaticSettlement: true,
    liveCollection: true,
    nativeSettlementBridge: true
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
