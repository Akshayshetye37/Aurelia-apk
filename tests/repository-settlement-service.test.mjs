import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { IndexedDbPmsRepository } from "../src/storage/indexeddb-pms-repository.mjs";
import { PmsRepositoryBridge } from "../src/storage/pms-repository-bridge.mjs";
import { settlePaymentToRepository } from "../src/payments/repository-settlement-service.mjs";

let databaseSequence = 0;
function fixture() {
  const databaseName = "repository-settlement-" + (++databaseSequence);
  const repository = new IndexedDbPmsRepository({ indexedDBImpl: indexedDB, databaseName });
  let eventSequence = 0;
  const bridge = new PmsRepositoryBridge({
    tenantId: "tenant-local",
    propertyId: "property-local",
    deviceId: "device-local",
    now: () => "2026-11-08T12:00:00.000Z",
    eventId: () => "settlement-event-" + (++eventSequence)
  }).bindActiveEngine(repository);
  const booking = {
    id: 41, folioId: "folio-41", g: "Guest One", room: "101", st: "in",
    p: 0, pays: [], payments: [], ch: [], rate: 1000
  };
  const state = { tab: "stays", bk: {}, b: [booking], g: [], rooms: [], today: 0, aud: [] };
  return { repository, bridge, booking, state };
}
const balanceDueFor = booking => Math.max(0, 1000 - Number(booking.p || 0));

test("payment, booking, folio and recovery snapshot commit atomically with exact read-back", async () => {
  const { bridge, booking, state } = fixture();
  const result = await settlePaymentToRepository({
    bridge, state, booking, balanceDueFor, amount: 250, method: "Cash",
    source: "manual", idempotencyKey: "manual-request-41", verificationConfirmed: true
  });
  assert.equal(result.ok, true);
  assert.equal(result.canonical, true);
  assert.equal(booking.p, 250);
  assert.equal(booking.pays.length, 1);
  assert.equal(state.today, 250);

  const savedBooking = await bridge.fetchEntity("booking", "41");
  const savedFolio = await bridge.fetchEntity("folio", "folio-41");
  const savedSnapshot = await bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2");
  assert.deepEqual(savedBooking.data.pays, booking.pays);
  assert.equal(savedFolio.data.paidPaise, 25000);
  assert.equal(savedFolio.data.balanceDuePaise, 75000);
  assert.deepEqual(savedSnapshot.data.snapshot.b[0], booking);
  assert.equal(savedSnapshot.data.snapshot.today, 250);
});

test("idempotent retry returns the original canonical payment without a second credit", async () => {
  const { bridge, booking, state } = fixture();
  const input = {
    bridge, state, booking, balanceDueFor, amount: 250, method: "UPI",
    reference: "UTR-41", source: "manual", idempotencyKey: "utr:UTR-41",
    verificationConfirmed: true
  };
  const first = await settlePaymentToRepository(input);
  const second = await settlePaymentToRepository(input);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(booking.p, 250);
  assert.equal(booking.pays.length, 1);
  assert.equal((await bridge.fetchEntity("folio", "folio-41")).data.paidPaise, 25000);
});

test("canonical booking divergence fails closed instead of overwriting either copy", async () => {
  const { bridge, booking, state } = fixture();
  await bridge.mutateEntity({
    entityType: "booking", entityId: "41", expectedVersion: 0,
    eventType: "booking.seeded",
    mutate: entity => Object.assign(entity, { ...booking, g: "Different Guest" })
  });
  await assert.rejects(settlePaymentToRepository({
    bridge, state, booking, balanceDueFor, amount: 100, method: "Cash",
    source: "manual", verificationConfirmed: true
  }), error => error.code === "CANONICAL_BOOKING_DIVERGENCE");
  assert.equal(booking.p, 0);
  assert.equal(await bridge.fetchEntity("folio", "folio-41"), null);
});

test("provider and staff-review postings cannot bypass the trusted settlement projector", async () => {
  const { bridge, booking, state } = fixture();
  for (const source of ["staff_review", "verified_gateway", "auto"]) {
    await assert.rejects(settlePaymentToRepository({
      bridge, state, booking, balanceDueFor, amount: 100, method: "UPI",
      source, verificationConfirmed: true
    }), error => error.code === "TRUSTED_SETTLEMENT_PATH_REQUIRED");
  }
  assert.equal(booking.p, 0);
  assert.equal(await bridge.fetchEntity("folio", "folio-41"), null);
});

test("failed canonical transaction leaves the live folio untouched", async () => {
  const { bridge, booking, state } = fixture();
  const original = bridge.mutateEntities.bind(bridge);
  bridge.mutateEntities = async () => { throw new Error("simulated storage failure"); };
  await assert.rejects(settlePaymentToRepository({
    bridge, state, booking, balanceDueFor, amount: 100, method: "Cash",
    source: "manual", verificationConfirmed: true
  }), /simulated storage failure/);
  bridge.mutateEntities = original;
  assert.equal(booking.p, 0);
  assert.equal(booking.pays.length, 0);
  assert.equal(state.today, 0);
  assert.equal(await bridge.fetchEntity("booking", "41"), null);
  assert.equal(await bridge.fetchEntity("folio", "folio-41"), null);
});

test("legacy UI cache is refreshed only after the canonical payment snapshot is committed", async () => {
  const { bridge, booking, state } = fixture();
  const values = new Map();
  const legacyStorage = {
    memoryOnly: false,
    setItem: (key, value) => values.set(key, String(value)),
    getItem: key => values.has(key) ? values.get(key) : null
  };
  const result = await settlePaymentToRepository({
    bridge, state, booking, balanceDueFor, amount: 125, method: "Cash",
    source: "manual", verificationConfirmed: true, legacyStorage
  });
  assert.equal(result.cacheRefreshed, true);
  const cached = JSON.parse(values.get("aurelia_lodge_v2"));
  assert.equal(cached.b[0].p, 125);
  assert.equal(cached.b[0].pays.length, 1);
});
