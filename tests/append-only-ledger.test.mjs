import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { indexedDB } from "fake-indexeddb";
import { IndexedDbPmsRepository } from "../src/storage/indexeddb-pms-repository.mjs";
import { PmsRepositoryBridge } from "../src/storage/pms-repository-bridge.mjs";
import { buildPmsOutboxEvent } from "../src/storage/pms-repository-contract.mjs";
import { settlePaymentToRepository } from "../src/payments/repository-settlement-service.mjs";
import { projectLegacyPmsDomains } from "../src/storage/pms-domain-cutover.mjs";

let sequence = 0;
function fixture() {
  const repository = new IndexedDbPmsRepository({
    indexedDBImpl: indexedDB,
    databaseName: "append-only-ledger-" + (++sequence),
    now: () => "2026-11-15T12:00:00.000Z"
  });
  let eventSequence = 0;
  const bridge = new PmsRepositoryBridge({
    tenantId: "tenant-local",
    propertyId: "property-local",
    deviceId: "device-local",
    now: () => "2026-11-15T12:00:00.000Z",
    eventId: () => "ledger-event-" + (++eventSequence)
  }).bindActiveEngine(repository);
  return { repository, bridge };
}

function event({ type, id, sequence: version, eventId }) {
  return buildPmsOutboxEvent({
    eventId,
    tenantId: "tenant-local",
    propertyId: "property-local",
    deviceId: "device-local",
    entityType: type,
    entityId: id,
    sequence: version,
    eventType: "test.ledger_mutation",
    occurredAt: "2026-11-15T12:00:00.000Z",
    payload: { test: true }
  });
}

test("ledger rows can be appended once but cannot be rewritten through the repository bridge", async () => {
  const { bridge } = fixture();
  await bridge.addLedgerLine({
    entityId: "payment-entry-0001",
    expectedVersion: 0,
    eventType: "ledger.payment_posted",
    mutate: row => Object.assign(row, {
      id: "payment-entry-0001",
      amountPaise: 12500,
      currency: "INR",
      direction: "CREDIT",
      idempotencyKey: "payment-command-0001"
    })
  });

  await assert.rejects(bridge.mutateEntity({
    entityType: "ledger",
    entityId: "payment-entry-0001",
    expectedVersion: 1,
    eventType: "ledger.rewritten",
    mutate: row => Object.assign(row, { amountPaise: 1 })
  }), error => error.code === "LEDGER_APPEND_ONLY");

  assert.equal((await bridge.fetchEntity("ledger", "payment-entry-0001")).data.amountPaise, 12500);
});

test("append-only enforcement exists in the IndexedDB adapter, not only the bridge", async () => {
  const { repository, bridge } = fixture();
  await bridge.addLedgerLine({
    entityId: "payment-entry-0002",
    expectedVersion: 0,
    eventType: "ledger.payment_posted",
    mutate: row => Object.assign(row, { id: "payment-entry-0002", amountPaise: 2500, currency: "INR" })
  });

  await assert.rejects(repository.transactBusinessChange({
    entityType: "ledger",
    entityId: "payment-entry-0002",
    expectedVersion: 1,
    event: event({ type: "ledger", id: "payment-entry-0002", sequence: 2, eventId: "ledger-rewrite-0002" })
  }, () => ({ id: "payment-entry-0002", amountPaise: 1 })), error => error.code === "LEDGER_APPEND_ONLY");

  assert.equal((await repository.getEntity("ledger", "payment-entry-0002")).data.amountPaise, 2500);
});

test("a batch cannot rewrite a ledger row or partially commit its other entities", async () => {
  const { repository, bridge } = fixture();
  await bridge.addLedgerLine({
    entityId: "payment-entry-0003",
    expectedVersion: 0,
    eventType: "ledger.payment_posted",
    mutate: row => Object.assign(row, { id: "payment-entry-0003", amountPaise: 7500, currency: "INR" })
  });

  await assert.rejects(repository.transactBusinessBatch([
    {
      entityType: "ledger",
      entityId: "payment-entry-0003",
      expectedVersion: 1,
      data: { id: "payment-entry-0003", amountPaise: 1, currency: "INR" },
      event: event({ type: "ledger", id: "payment-entry-0003", sequence: 2, eventId: "ledger-batch-rewrite" })
    },
    {
      entityType: "booking",
      entityId: "booking-atomic-0003",
      expectedVersion: 0,
      data: { id: "booking-atomic-0003", status: "should-not-commit" },
      event: event({ type: "booking", id: "booking-atomic-0003", sequence: 1, eventId: "booking-batch-side-effect" })
    }
  ]), error => error.code === "LEDGER_APPEND_ONLY");

  assert.equal(await repository.getEntity("booking", "booking-atomic-0003"), null);
  assert.equal((await repository.getEntity("ledger", "payment-entry-0003")).data.amountPaise, 7500);
});

test("canonical manual payment appends one integer-paise ledger row in the same business commit", async () => {
  const { bridge } = fixture();
  const booking = {
    id: 41, folioId: "folio-41", g: "Guest One", room: "101", st: "in",
    p: 0, pays: [], payments: [], ch: [], rate: 1000
  };
  const state = { tab: "stays", bk: {}, b: [booking], g: [], rooms: [], today: 0, aud: [], led: [] };

  const result = await settlePaymentToRepository({
    bridge,
    state,
    booking,
    balanceDueFor: row => Math.max(0, 1000 - Number(row.p || 0)),
    amount: 125,
    method: "Cash",
    source: "manual",
    idempotencyKey: "manual-ledger-command-0041",
    verificationConfirmed: true,
    now: () => "2026-11-15T12:00:00.000Z"
  });

  assert.equal(result.canonical, true);
  const rows = await bridge.listEntities("ledger");
  assert.equal(rows.length, 1);
  const committedSnapshot = await bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2");
  assert.deepEqual(committedSnapshot.data.snapshot.led, [rows[0].data]);
  assert.deepEqual(state.led, [rows[0].data]);
  assert.deepEqual(rows[0].data, {
    id: rows[0].id,
    tenantId: "tenant-local",
    propertyId: "property-local",
    deviceId: "device-local",
    bookingId: "41",
    folioId: "folio-41",
    amountPaise: 12500,
    currency: "INR",
    direction: "CREDIT",
    method: "Cash",
    reference: "",
    source: "manual",
    idempotencyKey: "manual-ledger-command-0041",
    reversalOf: null,
    createdAt: "2026-11-15T12:00:00.000Z"
  });
});

const androidRepositorySource = readFileSync(
  new URL("../android/templates/LocalPmsRepository.java", import.meta.url),
  "utf8"
);

test("Android SQLite rejects ledger rewrites in both single and batch transactions", () => {
  const guards = androidRepositorySource.match(
    /"ledger"\.equals\(type\)&&actual>0\)throw new IllegalStateException\("LEDGER_APPEND_ONLY"\)/g
  ) || [];
  assert.equal(guards.length, 2);
});

test("canonical payment posting refuses to proceed without a stable idempotency key", async () => {
  const { bridge } = fixture();
  const booking = {
    id: 42, folioId: "folio-42", g: "Guest Two", room: "102", st: "in",
    p: 0, pays: [], payments: [], ch: [], rate: 1000
  };
  const state = { tab: "stays", bk: {}, b: [booking], g: [], rooms: [], today: 0, aud: [] };
  await assert.rejects(settlePaymentToRepository({
    bridge,
    state,
    booking,
    balanceDueFor: row => Math.max(0, 1000 - Number(row.p || 0)),
    amount: 100,
    method: "Cash",
    source: "manual",
    verificationConfirmed: true,
    now: () => "2026-11-15T12:00:00.000Z"
  }), error => error.code === "PAYMENT_IDEMPOTENCY_KEY_REQUIRED");
  assert.equal((await bridge.listEntities("ledger")).length, 0);
  assert.equal(await bridge.fetchEntity("folio", "folio-42"), null);
});

test("domain projection preserves stable IDs for canonical ledger entries", async () => {
  const { bridge } = fixture();
  const entry = {
    id: "payment:0123456789abcdef",
    tenantId: "tenant-local",
    propertyId: "property-local",
    deviceId: "device-local",
    bookingId: "41",
    folioId: "folio-41",
    amountPaise: 1000,
    currency: "INR",
    direction: "CREDIT",
    method: "Cash",
    reference: "",
    source: "manual",
    idempotencyKey: "projection-test-command",
    reversalOf: null,
    createdAt: "2026-11-15T12:00:00.000Z"
  };
  await projectLegacyPmsDomains({
    bridge,
    migrationId: "migration-ledger-projection",
    snapshot: {
      rooms: [], b: [], g: [], t: [], exp: [], inv: [], led: [entry], aud: [],
      set: {}, menu: {}
    }
  });
  const rows = await bridge.listEntities("ledger");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, entry.id);
  assert.deepEqual(rows[0].data, entry);
});
