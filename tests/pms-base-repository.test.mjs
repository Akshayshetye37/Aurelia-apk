import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { IndexedDbPmsRepository } from "../src/storage/indexeddb-pms-repository.mjs";
import { PmsRepositoryBridge } from "../src/storage/pms-repository-bridge.mjs";
import { BaseRepo } from "../src/storage/pms-base-repository.mjs";
import { GuestRepo, RoomRepo, ReservationRepo, FolioRepo, PaymentRepo } from "../src/storage/pms-domain-repositories.mjs";

let eventSequence = 0;
async function makeRepo(entityType, databaseName) {
  const adapter = new IndexedDbPmsRepository({ indexedDBImpl: indexedDB, databaseName });
  await adapter.database();
  const bridge = new PmsRepositoryBridge({
    tenantId: "tenant-base-repo", propertyId: "property-base-repo", deviceId: "device-base-repo",
    eventId: () => "base-repo-event-" + (++eventSequence)
  });
  bridge.bindActiveEngine(adapter, { tenantId: "tenant-base-repo", propertyId: "property-base-repo", deviceId: "device-base-repo" });
  return { repo: new BaseRepo({ bridge, entityType, authorize: () => true, now: () => "2026-11-10T00:00:00.000Z" }), adapter };
}

test("BaseRepo validates writes, persists through the canonical bridge and enforces optimistic versions", async () => {
  const { repo, adapter } = await makeRepo("inventory", "base-repo-inventory-contract");
  try {
    const created = await repo.create("coffee", { n: "Coffee", q: 8, ro: 2, u: 5.25, price: 20 });
    assert.equal(created.version, 1);
    assert.equal((await repo.get("coffee")).data.q, 8);
    const updated = await repo.update("coffee", 1, row => ({ ...row, q: 7 }));
    assert.equal(updated.version, 2);
    assert.equal(updated.data.q, 7);
    await assert.rejects(repo.update("coffee", 1, row => ({ ...row, q: 6 })), error => error.code === "ENTITY_VERSION_CONFLICT");
    await assert.rejects(repo.update("coffee", 2, row => ({ ...row, q: 1.5 })), error => error.code === "PMS_DOMAIN_VALIDATION_FAILED");
    assert.equal((await repo.get("coffee")).data.q, 7);
    await repo.retire("coffee", 2);
    assert.equal((await repo.get("coffee")).data.retired, true);
    assert.equal((await repo.list()).length, 1);
  } finally { adapter.close?.(); }
});

test("BaseRepo never exposes update or retire for append-only ledger and audit entities", async () => {
  const { repo } = await makeRepo("ledger", "base-repo-ledger-immutable");
  await assert.rejects(repo.update("payment-1", 1, row => row), error => error.code === "PMS_ENTITY_IMMUTABLE");
  await assert.rejects(repo.retire("payment-1", 1), error => error.code === "PMS_ENTITY_IMMUTABLE");
});

test("BaseRepo rejects malformed identities and unsupported entity types", async () => {
  const { repo } = await makeRepo("guest", "base-repo-identity");
  await assert.rejects(repo.create("", { n: "Invalid" }));
  assert.throws(() => new BaseRepo({ bridge: {}, entityType: "unknown" }));
});

test("the shared bridge validates every domain mutation before persistence", async () => {
  const { IndexedDbPmsRepository } = await import("../src/storage/indexeddb-pms-repository.mjs");
  const { PmsRepositoryBridge } = await import("../src/storage/pms-repository-bridge.mjs");
  const adapter = new IndexedDbPmsRepository({ indexedDBImpl: indexedDB, databaseName: "bridge-zod-write-guard" });
  await adapter.database();
  const bridge = new PmsRepositoryBridge({
    tenantId: "tenant-base-repo", propertyId: "property-base-repo", deviceId: "device-base-repo",
    eventId: () => "bridge-zod-event"
  });
  bridge.bindActiveEngine(adapter, { tenantId: "tenant-base-repo", propertyId: "property-base-repo", deviceId: "device-base-repo" });
  try {
    await assert.rejects(
      bridge.mutateEntity({
        entityType: "inventory", entityId: "bad-stock", expectedVersion: 0,
        eventType: "inventory.created",
        mutate: row => Object.assign(row, { n: "Invalid", q: 1.5, ro: 0 })
      }),
      error => error.code === "PMS_DOMAIN_VALIDATION_FAILED"
    );
    assert.equal(await bridge.fetchEntity("inventory", "bad-stock"), null);
    const good = await bridge.mutateEntity({
      entityType: "inventory", entityId: "good-stock", expectedVersion: 0,
      eventType: "inventory.created",
      mutate: row => Object.assign(row, { n: "Coffee", q: 4, ro: 1, u: 3.5 })
    });
    assert.equal(good.entity.version, 1);
  } finally { adapter.close?.(); }
});

test("BaseRepo requires an explicit permission evaluator and checks each operation", async () => {
  const adapter = new IndexedDbPmsRepository({ indexedDBImpl: indexedDB, databaseName: "base-repo-permissions" });
  await adapter.database();
  const calls = [];
  const bridge = new PmsRepositoryBridge({
    tenantId: "tenant-base-repo", propertyId: "property-base-repo", deviceId: "device-base-repo",
    eventId: () => "base-repo-permission-event"
  });
  bridge.bindActiveEngine(adapter, { tenantId: "tenant-base-repo", propertyId: "property-base-repo", deviceId: "device-base-repo" });
  assert.throws(() => new BaseRepo({ bridge, entityType: "guest" }), /explicit repository permission evaluator/);
  const denied = new BaseRepo({
    bridge, entityType: "guest",
    authorize: request => { calls.push(request); return request.action !== "create"; }
  });
  try {
    await assert.rejects(denied.create("guest-denied", { n: "Denied" }),
      error => error.code === "PMS_REPOSITORY_PERMISSION_DENIED" && error.action === "create");
    assert.equal(await bridge.fetchEntity("guest", "guest-denied"), null);
    assert.deepEqual(calls.map(call => call.action), ["create"]);
  } finally { adapter.close?.(); }
});

test("domain repository adapters bind guest, room, reservation and folio domains", async () => {
  const adapter = new IndexedDbPmsRepository({ indexedDBImpl: indexedDB, databaseName: "pms-domain-repository-bindings" });
  await adapter.database();
  const bridge = new PmsRepositoryBridge({
    tenantId: "tenant-domain-repos", propertyId: "property-domain-repos", deviceId: "device-domain-repos"
  });
  bridge.bindActiveEngine(adapter, {
    tenantId: "tenant-domain-repos", propertyId: "property-domain-repos", deviceId: "device-domain-repos"
  });
  const authorize = () => true;
  try {
    assert.equal(new GuestRepo({ bridge, authorize }).entityType, "guest");
    assert.equal(new RoomRepo({ bridge, authorize }).entityType, "room");
    assert.equal(new ReservationRepo({ bridge, authorize }).entityType, "booking");
    assert.equal(new FolioRepo({ bridge, authorize }).entityType, "folio");
    assert.equal(new PaymentRepo({ bridge, authorize }).entityType, "payment");
    const payments = new PaymentRepo({ bridge, authorize, now: () => "2026-11-10T00:00:00.000Z" });
    const payment = await payments.create("payment-1", {
      bookingId: "booking-1", folioId: "folio-1", transactionId: "txn-1",
      provider: "razorpay", environment: "test", amountMinor: 5000, currency: "INR",
      status: "created", idempotencyKey: "payment-1", createdAt: "2026-11-10T00:00:00.000Z"
    });
    const pending = await payments.transition("payment-1", payment.version, "pending");
    assert.equal(pending.data.status, "pending");
    await assert.rejects(payments.transition("payment-1", pending.version, "refunded"),
      error => error.code === "PMS_INVALID_STATE_TRANSITION");
    assert.throws(() => new GuestRepo({ bridge, authorize, entityType: "room" }), /cannot be rebound/);
  } finally { adapter.close?.(); }
});

test("guest, room, reservation, folio and payment repositories pass CRUD conflict rollback and restart contracts", async () => {
  const cases = [
    [GuestRepo, "guest", "guest-contract", { n: "Contract Guest", ph: "+911234567890" }, { ph: "+919876543210" }],
    [RoomRepo, "room", "room-contract", { n: "101", t: "Deluxe", r: 1200, s: "ready" }, { s: "occ" }],
    [ReservationRepo, "booking", "booking-contract", {
      g: "Contract Guest", room: "101", in: 10, out: 12, st: "res", rate: 1200, p: 0,
      ch: [], pays: [], checkInTime: "14:00", checkOutTime: "11:00"
    }, { st: "in" }],
    [FolioRepo, "folio", "folio-contract", {
      bookingId: "booking-contract", paymentRows: [], paidPaise: 0, balanceDuePaise: 120000
    }, { balanceDuePaise: 0 }],
    [PaymentRepo, "payment", "payment-contract", {
      bookingId: "booking-contract", folioId: "folio-contract", transactionId: "txn-contract",
      provider: "razorpay", environment: "test", amountMinor: 120000, currency: "INR",
      status: "created", idempotencyKey: "payment-contract", createdAt: "2026-11-10T00:00:00.000Z"
    }, { status: "pending" }]
  ];
  for (const [Repo, entityType, id, initial, patch] of cases) {
    const databaseName = "domain-contract-" + entityType;
    const adapter = new IndexedDbPmsRepository({ indexedDBImpl: indexedDB, databaseName });
    await adapter.database();
    let eventNo = 0;
    const makeBridge = engine => {
      const bridge = new PmsRepositoryBridge({
        tenantId: "tenant-domain-contract", propertyId: "property-domain-contract",
        deviceId: "device-domain-contract", eventId: () => "domain-" + entityType + "-" + (++eventNo)
      });
      bridge.bindActiveEngine(engine, {
        tenantId: "tenant-domain-contract", propertyId: "property-domain-contract",
        deviceId: "device-domain-contract"
      });
      return bridge;
    };
    const authorize = () => true;
    const repo = new Repo({ bridge: makeBridge(adapter), authorize });
    try {
      const created = await repo.create(id, initial);
      const updated = await repo.update(id, created.version, current => ({ ...current, ...patch }));
      assert.equal(updated.version, created.version + 1, entityType + " version must increment once");
      await assert.rejects(repo.update(id, created.version, current => current),
        error => error.code === "ENTITY_VERSION_CONFLICT");
      const beforeRollback = await repo.get(id);
      await assert.rejects(repo.update(id, updated.version, current => ({ ...current, notAllowed: true })),
        error => error.code === "PMS_DOMAIN_VALIDATION_FAILED");
      assert.deepEqual(await repo.get(id), beforeRollback, entityType + " failed write must roll back");
      adapter.close?.();
      const reopened = new IndexedDbPmsRepository({ indexedDBImpl: indexedDB, databaseName });
      await reopened.database();
      const afterRestart = new Repo({ bridge: makeBridge(reopened), authorize });
      assert.deepEqual(await afterRestart.get(id), beforeRollback, entityType + " state must survive restart");
      reopened.close?.();
    } finally { adapter.close?.(); }
  }
});
