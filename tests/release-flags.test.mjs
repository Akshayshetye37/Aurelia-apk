import test from "node:test";
import assert from "node:assert/strict";
import { RELEASE_FLAGS, assertReleaseFlagsOff } from "../src/release-flags.mjs";

test("R1 release safety flags are explicitly OFF by default", () => {
  assert.deepEqual(RELEASE_FLAGS, {
    uiCutover: false,
    sync: false,
    gatewayPayments: false
  });
  assert.equal(assertReleaseFlagsOff(), true);
});

test("release safety gate rejects any enabled or missing flag", () => {
  for (const flags of [
    { ...RELEASE_FLAGS, uiCutover: true },
    { ...RELEASE_FLAGS, sync: true },
    { ...RELEASE_FLAGS, gatewayPayments: true },
    { uiCutover: false, sync: false }
  ]) {
    assert.throws(() => assertReleaseFlagsOff(flags), /R1 release safety flags|Missing required/);
  }
});
