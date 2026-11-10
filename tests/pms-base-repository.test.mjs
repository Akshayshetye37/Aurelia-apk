import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { IndexedDbPmsRepository } from "../src/storage/indexeddb-pms-repository.mjs";
import { PmsRepositoryBridge } from "../src/storage/pms-repository-bridge.mjs";
import { BaseRepo } from "../src/storage/pms-base-repository.mjs";

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
