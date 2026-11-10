import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { indexedDB } from "fake-indexeddb";
import fc from "fast-check";
import { IndexedDbPmsRepository } from "../../src/storage/indexeddb-pms-repository.mjs";

const operationsArbitrary = fc.array(
  fc.record({
    idSuffix: fc.integer({ min: 0, max: 3 }),
    balanceMinor: fc.integer({ min: 0, max: 2_000_000_000 })
  }),
  { minLength: 1, maxLength: 32 }
);

function createRepo(name) {
  return new IndexedDbPmsRepository({
    indexedDBImpl: indexedDB,
    databaseName: "pms-property-" + name,
    now: () => "2026-11-10T00:00:00.000Z"
  });
}

function event(caseIndex, operationIndex, entityId, sequence) {
  return {
    eventId: "property-" + caseIndex + "-" + operationIndex,
    tenantId: "tenant-property",
    propertyId: "property-property",
    deviceId: "device-property",
    entityType: "folio",
    entityId,
    sequence,
    schemaVersion: 1,
    eventType: "folio.property_test",
    occurredAt: new Date(Date.UTC(2026, 10, 10, 0, 0, operationIndex)).toISOString(),
    payload: { operationIndex }
  };
}

async function runSequence(caseIndex, operations) {
  const repository = createRepo(String(caseIndex));
  const model = new Map();
  const serializedOperations = [];
  for (let i = 0; i < operations.length; i++) {
    const operation = operations[i];
    const id = "property-" + caseIndex + "-folio-" + operation.idSuffix;
    const previous = model.get(id);
    const version = previous?.version ?? 0;
    const createdAt = previous?.data.createdAt ??
      new Date(Date.UTC(2026, 10, 10, 0, 0, i)).toISOString();
    const data = { id, balanceMinor: operation.balanceMinor, currency: "INR", createdAt };
    const occurredAt = new Date(Date.UTC(2026, 10, 10, 0, 0, i)).toISOString();
    const outboxEvent = event(caseIndex, i, id, version + 1);
    outboxEvent.occurredAt = occurredAt;
    await repository.transactBusinessChange({
      entityType: "folio", entityId: id, expectedVersion: version, event: outboxEvent
    }, () => data);
    model.set(id, { version: version + 1, data });
    serializedOperations.push({ id, balanceMinor: operation.balanceMinor, createdAt, occurredAt });
  }

  for (const [id, current] of model) {
    await assert.rejects(repository.transactBusinessChange({
      entityType: "folio", entityId: id, expectedVersion: current.version - 1,
      event: event(caseIndex, operations.length + current.version, id, current.version)
    }, () => ({ ...current.data, balanceMinor: 0 })), error => error.code === "ENTITY_VERSION_CONFLICT");
  }

  const expected = [...model.entries()]
    .map(([id, value]) => ({ id, version: value.version, data: value.data }))
    .sort((a, b) => a.data.createdAt.localeCompare(b.data.createdAt) || a.id.localeCompare(b.id));
  const actual = (await repository.listEntities("folio"))
    .filter(row => row.id.startsWith("property-" + caseIndex + "-"))
    .map(row => ({ id: row.id, version: row.version, data: row.data }));
  assert.deepEqual(actual, expected);
  const pending = await repository.claimOutboxBatch({ deviceId: "device-property", limit: 100 });
  assert.equal(pending.filter(row => row.entityId.startsWith("property-" + caseIndex + "-")).length, operations.length);
  return { operations: serializedOperations, expected };
}

test("fast-check generated operation sequences preserve repository model, versions, ordering and outbox", async () => {
  let run = 0;
  await fc.assert(fc.asyncProperty(operationsArbitrary, async operations => {
    await runSequence("property-run-" + run++, operations);
  }), { numRuns: 24, seed: 20261110, endOnFailure: true });
});

test("deterministic fast-check vectors are exported for the native SQLite engine", async () => {
  const samples = fc.sample(operationsArbitrary, { seed: 20261110, numRuns: 12 });
  const cases = [];
  for (let i = 0; i < samples.length; i++) cases.push(await runSequence("native-" + i, samples[i]));
  const output = process.env.AURELIA_PROPERTY_FIXTURE_PATH;
  if (output) fs.writeFileSync(output, JSON.stringify({ schemaVersion: 1, cases }, null, 2) + "\n");
});
