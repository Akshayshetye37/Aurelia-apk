import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { IndexedDbPmsRepository } from "../src/storage/indexeddb-pms-repository.mjs";
import { PmsRepositoryBridge } from "../src/storage/pms-repository-bridge.mjs";
import { settlePaymentToRepository } from "../src/payments/repository-settlement-service.mjs";

let serial = 0;
function setup() {
  const repository = new IndexedDbPmsRepository({
    indexedDBImpl: indexedDB,
    databaseName: "repository-settlement-" + (++serial),
    now: () => "2026-11-07T10:00:00.000Z"
  });
  const bridge = new PmsRepositoryBridge({
    tenantId: "tenant-local-test",
    propertyId: "property-local-test",
    deviceId: "device-local-test",
    eventId: (() => { let n = 0; return () => "settlement-event-" + (++n); })(),
    now: () => "2026-11-07T10:00:00.000Z"
  });
  bridge.bindActiveEngine(repository);
  const booking = {
    id: 41,
    folioId: "folio-41",
    g: "Test Guest",
    room: "101",
    st: "in",
    rate: 1000,
    ch: [],
    dc: 0,
    pays: [],
    payments: [],
    p: 0
  };
  const state = { b: [booking], today: 0, aud: [] };
  return { repository, bridge, booking, state };
}

const command = ({ bridge, state, booking, amount = 100, idempotencyKey = "manual-payment-41" }) =>
  settlePaymentToRepository({
    bridge, state, booking,
    balanceDueFor: folio => Math.max(0, 1000 - Number(folio.p || 0)),
    amount,
    method: "Cash",
    reference: "",
    source: "manual",
    idempotencyKey,
    verificationConfirmed: true,
    now: () => "2026-11-07T10:00:00.000Z"
  });

test("manual settlement commits folio and immutable outbox event atomically", async () => {
  const ctx = setup();
  const result = await command(ctx);
  assert.equal(result.ok, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.entity.version, 1);
  assert.equal(ctx.booking.p, 100);
  assert.equal(ctx.booking.pays.length, 1);
  assert.equal(ctx.state.today, 100);
  assert.equal(ctx.state.aud.length, 1);

  const stored = await ctx.bridge.fetchEntity("folio", "folio-41");
  assert.equal(stored.version, 1);
  assert.equal(stored.data.p, 100);
  assert.equal(stored.data.pays[0].idempotencyKey, "manual-payment-41");

  const events = await ctx.repository.claimOutboxBatch({ deviceId: "device-local-test" });
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, "folio.payment_posted");
  assert.deepEqual(events[0].payload, {
    bookingId: "folio-41",
    amountPaise: 10000,
    method: "Cash",
    reference: "",
    source: "manual",
    idempotencyKey: "manual-payment-41"
  });
});

test("duplicate payment replay returns the original result without a second outbox event", async () => {
  const ctx = setup();
  const first = await command(ctx);
  const second = await command(ctx);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(ctx.booking.pays.length, 1);
  assert.equal((await ctx.bridge.fetchEntity("folio", "folio-41")).version, 1);
  assert.equal((await ctx.repository.claimOutboxBatch({ deviceId: "device-local-test" })).length, 1);
});

test("invalid or over-balance payment leaves repository and live projection unchanged", async () => {
  const ctx = setup();
  await assert.rejects(command({ ...ctx, amount: 1200 }), /exceeds the balance due/);
  assert.equal(await ctx.bridge.fetchEntity("folio", "folio-41"), null);
  assert.equal(ctx.booking.p, 0);
  assert.equal(ctx.booking.pays.length, 0);
  assert.equal(ctx.state.today, 0);
  assert.equal((await ctx.repository.claimOutboxBatch({ deviceId: "device-local-test" })).length, 0);
});

test("concurrent settlements against one folio cannot double-post or advance the live projection twice", async () => {
  const ctx = setup();
  const outcomes = await Promise.allSettled([
    command({ ...ctx, idempotencyKey: "race-payment-a" }),
    command({ ...ctx, idempotencyKey: "race-payment-b" })
  ]);
  assert.equal(outcomes.filter(x => x.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(x => x.status === "rejected" && x.reason.code === "ENTITY_VERSION_CONFLICT").length, 1);
  const stored = await ctx.bridge.fetchEntity("folio", "folio-41");
  assert.equal(stored.version, 1);
  assert.equal(stored.data.pays.length, 1);
  assert.equal(stored.data.p, 100);
  assert.equal(ctx.booking.pays.length, 1);
  assert.equal(ctx.booking.p, 100);
  const events = await ctx.repository.claimOutboxBatch({ deviceId: "device-local-test" });
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, "folio.payment_posted");
});
