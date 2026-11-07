import test from "node:test";
import assert from "node:assert/strict";
import { buildLegacyBookingShadowPlan } from "../src/storage/legacy-booking-shadow-plan.mjs";

test("shadow plan preserves every booking field and financial history verbatim", () => {
  const booking = {
    id: 41, g: "Guest", room: "101", in: 12, out: 14, st: "res",
    p: 1250, pays: [{ a: 500, amountPaise: 50000, reference: "cash" }],
    payments: [{ amount: 500, customHistoryField: true }],
    futureUnknownField: { nested: ["keep", "exact"] }
  };
  const snapshot = { b: [booking], cancelled: [] };
  const before = structuredClone(snapshot);
  const plan = buildLegacyBookingShadowPlan(snapshot, {
    tenantId: "tenant-a", propertyId: "property-a"
  });
  assert.equal(plan.blocked, false);
  assert.equal(plan.scanned, 1);
  assert.equal(plan.planned, 1);
  assert.equal(plan.projections[0].entityId, "legacy-booking:41");
  assert.deepEqual(plan.projections[0].data.legacyRecord, booking);
  assert.deepEqual(snapshot, before);
  assert.equal(plan.projections[0].data.tenantId, "tenant-a");
  assert.equal(plan.projections[0].data.propertyId, "property-a");
});

test("shadow plan is deterministic across replay and collection ordering", () => {
  const snapshot = {
    b: [{ id: 8, g: "B" }, { id: 3, g: "A" }],
    cancelled: [{ id: 5, g: "C" }]
  };
  const options = { tenantId: "tenant-a", propertyId: "property-a" };
  const first = buildLegacyBookingShadowPlan(snapshot, options);
  const replay = buildLegacyBookingShadowPlan(structuredClone(snapshot), options);
  assert.deepEqual(replay, first);
  assert.deepEqual(first.projections.map(row => row.entityId), [
    "legacy-booking:3", "legacy-booking:5", "legacy-booking:8"
  ]);
});

test("duplicate IDs across active and cancelled collections are both blocked", () => {
  const plan = buildLegacyBookingShadowPlan({
    b: [{ id: 7, g: "Active" }],
    cancelled: [{ id: "7", g: "Cancelled" }]
  }, { tenantId: "tenant-a", propertyId: "property-a" });
  assert.equal(plan.planned, 0);
  assert.equal(plan.blocked, true);
  assert.equal(plan.issues.filter(x => x.code === "AMBIGUOUS_LEGACY_BOOKING_ID").length, 2);
});

test("missing IDs and malformed rows are reported and never assigned invented identities", () => {
  const plan = buildLegacyBookingShadowPlan({
    b: [{ g: "No ID" }, null, { id: 9, g: "Valid" }],
    cancelled: []
  }, { tenantId: "tenant-a", propertyId: "property-a" });
  assert.equal(plan.planned, 1);
  assert.deepEqual(plan.issues.map(x => x.code), [
    "MISSING_OR_INVALID_BOOKING_ID", "MALFORMED_BOOKING"
  ]);
  assert.equal(plan.blocked, true);
});

test("shadow plan requires explicit tenant and property scope", () => {
  assert.throws(() => buildLegacyBookingShadowPlan({ b: [] }, {
    tenantId: "tenant-a"
  }), /Invalid property ID/);
  assert.throws(() => buildLegacyBookingShadowPlan({ b: {}, cancelled: [] }, {
    tenantId: "tenant-a", propertyId: "property-a"
  }), /must be an array/);
});
