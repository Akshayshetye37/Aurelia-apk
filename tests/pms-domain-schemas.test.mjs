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

test("reservation schema is strict and validates canonical dates, lifecycle and identity", () => {
  const booking = validatePmsDomainEntity("booking", {
    id: 7, g: "Guest One", room: "101", in: 10, out: 12, st: "res",
    rate: 1200, p: 200, ch: [], pays: [], folioId: "booking-7",
    checkInTime: "14:00", checkOutTime: "11:00",
    scheduledCheckIn: "2026-11-10T14:00", scheduledCheckOut: "2026-11-12T11:00"
  });
  assert.equal(booking.id, 7);
  assert.equal(booking.st, "res");
  assert.throws(() => validatePmsDomainEntity("booking", {
    id: 8, g: "Guest Two", room: "102", in: 10, out: 12, st: "res", arbitrary: "not allowlisted"
  }), error => error.code === "PMS_DOMAIN_VALIDATION_FAILED");
  assert.throws(() => validatePmsDomainEntity("booking", {
    id: 9, g: "Guest Three", room: "103", in: 12, out: 12, st: "res"
  }), error => error.code === "PMS_DOMAIN_VALIDATION_FAILED");
});

test("folio schema enforces integer paise totals and a strict payment evidence envelope", () => {
  const folio = validatePmsDomainEntity("folio", {
    id: "folio-1", bookingId: 1, paymentRows: [{ a: 100, method: "Cash" }],
    paidPaise: 10000, balanceDuePaise: 50000, updatedAt: "2026-11-10T00:00:00.000Z"
  });
  assert.equal(folio.paidPaise, 10000);
  assert.throws(() => validatePmsDomainEntity("folio", {
    id: "folio-2", bookingId: 2, paymentRows: [], paidPaise: 10.5, balanceDuePaise: 0
  }), error => error.code === "PMS_DOMAIN_VALIDATION_FAILED");
  assert.throws(() => validatePmsDomainEntity("folio", {
    id: "folio-3", bookingId: 3, paymentRows: [], paidPaise: 0, balanceDuePaise: 0, unreviewed: true
  }), error => error.code === "PMS_DOMAIN_VALIDATION_FAILED");
});
