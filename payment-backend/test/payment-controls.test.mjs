import test from "node:test";
import assert from "node:assert/strict";
import {
  PAYMENT_CONTROL_DEFAULTS, normalizePaymentControls, paymentControlAllows,
  assertPaymentControl, updatePaymentControls, readPaymentControls
} from "../src/payment-controls/firestore-controls.mjs";

test("missing, malformed and incomplete control state fails closed", () => {
  assert.equal(paymentControlAllows(null, "manual_posting"), false);
  assert.equal(normalizePaymentControls({ schemaVersion: 1, emergency_stop: false }).controlState, "INVALID_FAIL_CLOSED");
  assert.equal(paymentControlAllows(PAYMENT_CONTROL_DEFAULTS, "test_collection"), false);
});

test("emergency stop dominates every capability", () => {
  const controls = { ...PAYMENT_CONTROL_DEFAULTS, emergency_stop: true, manual_posting: true };
  assert.equal(paymentControlAllows(controls, "manual_posting"), false);
  assert.throws(() => assertPaymentControl(controls, "manual_posting"), { code: "PAYMENT_EMERGENCY_STOP" });
});

test("a capability is allowed only when emergency stop is off and its own flag is on", () => {
  const controls = { ...PAYMENT_CONTROL_DEFAULTS, emergency_stop: false, manual_posting: true };
  assert.equal(paymentControlAllows(controls, "manual_posting"), true);
  assert.equal(paymentControlAllows(controls, "test_collection"), false);
});

test("unknown control identifiers are rejected", () => {
  assert.throws(() => paymentControlAllows(PAYMENT_CONTROL_DEFAULTS, "anything"));
});

test("Firestore read errors fail closed", async () => {
  const state = await readPaymentControls({ db: { doc: () => ({ get: async () => { throw new Error("offline"); } }) }, tenantId: "tenant_123" });
  assert.equal(state.controlState, "READ_FAILED");
  assert.equal(state.emergency_stop, true);
});

test("updates atomically write previous/new values and actor/reason audit evidence", async () => {
  let stored = null, audit = null;
  const db = {
    doc: () => ({ get: async () => ({ exists: !!stored, data: () => stored }) }),
    collection: () => ({ doc: () => ({ id: "audit-1" }) }),
    runTransaction: async fn => fn({
      get: async () => ({ exists: !!stored, data: () => stored }),
      set: (ref, value) => { if (ref.id === "audit-1") audit = value; else stored = value; }
    })
  };
  const result = await updatePaymentControls({
    db, tenantId: "tenant_123", actor: { uid: "owner-1", email: "owner@example.test" },
    changes: { manual_posting: true }, reason: "Reviewed in test",
    now: () => new Date("2026-11-04T12:00:00.000Z")
  });
  assert.equal(result.controls.emergency_stop, true);
  assert.equal(result.controls.manual_posting, true);
  assert.equal(audit.entries[0].from, false);
  assert.equal(audit.entries[0].to, true);
  assert.equal(audit.entries[0].actorEmail, "owner@example.test");
  assert.equal(audit.entries[0].reason, "Reviewed in test");
});

test("updates reject invalid flags, missing reason and invalid actor", async () => {
  const db = {};
  await assert.rejects(updatePaymentControls({ db, tenantId: "tenant_123", actor: { uid: "x", email: "x@y.z" }, changes: { live_collection: "true" }, reason: "x" }));
  await assert.rejects(updatePaymentControls({ db, tenantId: "tenant_123", actor: { uid: "x", email: "x@y.z" }, changes: { live_collection: true }, reason: "" }));
  await assert.rejects(updatePaymentControls({ db, tenantId: "tenant_123", actor: { uid: "x" }, changes: { live_collection: true }, reason: "x" }));
});
