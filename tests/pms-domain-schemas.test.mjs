import test from "node:test";
import assert from "node:assert/strict";
import { validatePmsDomainEntity, assertPmsStateTransition } from "../src/storage/pms-domain-schemas.mjs";

test("guest schema is strict while preserving supported identity and profile fields", () => {
  const guest = validatePmsDomainEntity("guest", {
    id: "guest-1", n: "Guest One", ph: "+911234567890", em: "", idt: "Passport", idn: "P123",
    occ: [{ n: "Second Guest", dob: "1990-01-01", rel: "Spouse" }],
    veh: [{ reg: "MH01AB1234", ty: "Car" }],
    imgKey: "guest-photo-1", demo: false
  });
  assert.equal(guest.n, "Guest One");
  assert.equal(guest.occ[0].rel, "Spouse");
  assert.throws(() => validatePmsDomainEntity("guest", { id: "guest-2", n: "Guest Two", unreviewedField: true }),
    error => error.code === "PMS_DOMAIN_VALIDATION_FAILED");
  assert.throws(() => validatePmsDomainEntity("guest", {
    id: "guest-3", n: "Guest Three", occ: [{ n: "Child", unknownNestedField: true }]
  }), error => error.code === "PMS_DOMAIN_VALIDATION_FAILED");
});

test("room schema strictly validates canonical identity, lifecycle and money precision", () => {
  const room = validatePmsDomainEntity("room", { id: "101", n: "101", t: "Deluxe", r: 1200.5, s: "ready" });
  assert.equal(room.r, 1200.5);
  assert.throws(() => validatePmsDomainEntity("room", {
    id: "102", n: "102", t: "Deluxe", r: 1200, s: "ready", unexpected: "ignored previously"
  }), error => error.code === "PMS_DOMAIN_VALIDATION_FAILED");
  assert.throws(() => validatePmsDomainEntity("room", {
    id: "103", n: "103", t: "Deluxe", r: 1200.555, s: "ready"
  }), error => error.code === "PMS_DOMAIN_VALIDATION_FAILED");
  assert.throws(() => validatePmsDomainEntity("room", {
    id: "104", n: "104", t: "Deluxe", r: 1200, s: "occupied"
  }), error => error.code === "PMS_DOMAIN_VALIDATION_FAILED");
});

test("room lifecycle transition table rejects illegal occupancy and maintenance transitions", () => {
  assert.equal(assertPmsStateTransition("room", { s: "ready" }, { s: "occ" }), true);
  assert.throws(() => assertPmsStateTransition("room", { s: "out" }, { s: "occ" }),
    error => error.code === "PMS_INVALID_STATE_TRANSITION");
  assert.equal(assertPmsStateTransition("room", { s: "maintenance" }, { s: "ready" }), true);
});
