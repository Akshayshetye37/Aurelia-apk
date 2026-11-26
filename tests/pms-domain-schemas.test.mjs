import test from "node:test";
import assert from "node:assert/strict";
import {
  PMS_DOMAIN_SCHEMAS,
  PMS_IMMUTABLE_ENTITY_TYPES,
  assertPmsStateTransition,
  validatePmsDomainEntity
} from "../src/storage/pms-domain-schemas.mjs";

test("PMS schemas accept supported operational entities without stripping legacy fields", () => {
  const booking = { id: 12, st: "res", g: "Guest", p: 1200, pays: [{ a: 300 }] };
  assert.equal(validatePmsDomainEntity("booking", booking), booking);
  assert.equal(booking.pays[0].a, 300);
  assert.equal(PMS_DOMAIN_SCHEMAS.room.safeParse({ id: "101", s: "ready", n: "101" }).success, true);
});

test("PMS schemas reject malformed IDs, lifecycle values, unsafe inventory and folio sequence values", () => {
  for (const value of ["", "  ", "bad\u0000id", "x".repeat(181), 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validatePmsDomainEntity("guest", { id: value }), error => error.code === "PMS_DOMAIN_VALIDATION_FAILED");
  }
  assert.throws(() => validatePmsDomainEntity("booking", { id: 1, st: "unknown" }), /unsupported booking lifecycle state/);
  assert.throws(() => validatePmsDomainEntity("room", { id: "101", s: "occupied" }), /unsupported room lifecycle state/);
  assert.throws(() => validatePmsDomainEntity("inventory", { id: 1, q: -1 }), /q must be a non-negative integer/);
  assert.throws(() => validatePmsDomainEntity("inventory", { id: 1, price: 1.001 }), /price must be a non-negative amount/);
  assert.throws(() => validatePmsDomainEntity("folio_sequence", { id: "seq", financialYear: "2026-27", nextNumber: 0 }), /invalid financial year/);
  assert.throws(() => validatePmsDomainEntity("unsupported", {}), /Unsupported PMS entity type/);
});

test("PMS lifecycle transitions reject illegal room and booking state changes", () => {
  assert.equal(assertPmsStateTransition("booking", { st: "res" }, { st: "in" }), true);
  assert.throws(() => assertPmsStateTransition("booking", { st: "done" }, { st: "in" }), error => error.code === "PMS_INVALID_STATE_TRANSITION");
  assert.equal(assertPmsStateTransition("room", { s: "ready" }, { s: "maintenance" }), true);
  assert.throws(() => assertPmsStateTransition("room", { s: "maintenance" }, { s: "occ" }), error => error.code === "PMS_INVALID_STATE_TRANSITION");
  assert.equal(PMS_IMMUTABLE_ENTITY_TYPES.has("ledger"), true);
  assert.equal(PMS_IMMUTABLE_ENTITY_TYPES.has("audit"), true);
});
