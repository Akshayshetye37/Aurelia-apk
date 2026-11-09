import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { IndexedDbPmsRepository } from "../src/storage/indexeddb-pms-repository.mjs";
import { PmsRepositoryBridge } from "../src/storage/pms-repository-bridge.mjs";
import { PmsExpenseRepository } from "../src/storage/pms-expense-repository.mjs";

function setup(name) {
  const repository = new IndexedDbPmsRepository({
    indexedDBImpl: indexedDB,
    databaseName: "pms-expenses-" + name,
    now: () => "2026-11-09T00:00:00.000Z"
  });
  const bridge = new PmsRepositoryBridge({
    tenantId: "tenant-local", propertyId: "property-local", deviceId: "device-local",
    eventId: (() => { let id = 0; return () => "expense-event-" + (++id); })()
  });
  bridge.bindActiveEngine(repository);
  return { repository, bridge, expenses: new PmsExpenseRepository({ bridge }) };
}

test("verified hydration restores legacy expenses from canonical stable entity IDs", async () => {
  const { bridge, expenses } = setup("legacy");
  await bridge.mutateEntity({
    entityType: "expense", entityId: "legacy-expense-0", expectedVersion: 0,
    eventType: "expense.migrated", eventPayload: { migration: true },
    mutate: entity => Object.assign(entity, {
      id: "legacy-expense-0", t: "Laundry", a: 850, cat: "Operations",
      date: "2026-11-01"
    })
  });
  const snapshot = { exp: [{ t: "Laundry", a: 800, cat: "Operations", date: "2026-11-01" }] };
  const hydrated = await expenses.hydrateSnapshot(snapshot, { enabled: true });
  assert.deepEqual(hydrated.exp, [{
    id: "legacy-expense-0", t: "Laundry", a: 850, cat: "Operations",
    date: "2026-11-01"
  }]);
  assert.equal(snapshot.exp[0].id, undefined);
});

test("canonical expenses created after migration are included in startup hydration", async () => {
  const { bridge, expenses } = setup("new-record");
  await bridge.mutateEntity({
    entityType: "expense", entityId: "expense-2026-001", expectedVersion: 0,
    eventType: "expense.created", eventPayload: { expenseId: "expense-2026-001" },
    mutate: entity => Object.assign(entity, {
      id: "expense-2026-001", t: "Internet", a: 999, cat: "Utilities"
    })
  });
  const hydrated = await expenses.hydrateSnapshot({ exp: [] }, { enabled: true });
  assert.deepEqual(hydrated.exp, [{
    id: "expense-2026-001", t: "Internet", a: 999, cat: "Utilities"
  }]);
});

test("verified expense hydration fails closed when a migrated entity is missing", async () => {
  const { expenses } = setup("missing");
  await assert.rejects(
    expenses.hydrateSnapshot({ exp: [{ t: "Electricity", a: 1200 }] }, { enabled: true }),
    error => error.code === "EXPENSE_ENTITY_MISSING"
  );
});

test("unverified expense hydration preserves compatibility snapshot without claiming canonical authority", async () => {
  const { expenses } = setup("shadow");
  const snapshot = { exp: [{ t: "Electricity", a: 1200 }] };
  const hydrated = await expenses.hydrateSnapshot(snapshot, { enabled: false });
  assert.deepEqual(hydrated, snapshot);
});
