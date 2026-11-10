import assert from "node:assert/strict";

const NOW = "2026-11-10T00:00:00.000Z";
const event = (eventId, entityId, sequence = 1, occurredAt = NOW) => ({
  eventId,
  tenantId: "tenant-contract",
  propertyId: "property-contract",
  deviceId: "device-contract",
  entityType: "folio",
  entityId,
  sequence,
  schemaVersion: 1,
  eventType: "folio.contract_test",
  occurredAt,
  payload: { contract: true }
});

/**
 * Engine-neutral transactional contract. makeRepo(label) must return an adapter
 * implementing getEntity, transactBusinessChange, claimOutboxBatch and
 * acknowledgeOutbox. Native SQLite mirrors these cases in its instrumentation
 * suite; the IndexedDB adapter executes this same runner directly.
 */
export async function runContract(makeRepo) {
  if (typeof makeRepo !== "function") throw new TypeError("runContract requires makeRepo(label).");

  const duplicate = await makeRepo("duplicate");
  await duplicate.transactBusinessChange(
    { entityType: "folio", entityId: "duplicate-first", expectedVersion: 0, event: event("duplicate-event", "duplicate-first") },
    () => ({ id: "duplicate-first", balanceMinor: 100 })
  );
  await assert.rejects(
    duplicate.transactBusinessChange(
      { entityType: "folio", entityId: "duplicate-second", expectedVersion: 0, event: event("duplicate-event", "duplicate-second") },
      () => ({ id: "duplicate-second", balanceMinor: 200 })
    )
  );
  assert.equal(await duplicate.getEntity("folio", "duplicate-second"), null);
  assert.equal((await duplicate.claimOutboxBatch({ deviceId: "device-contract", limit: 50 })).length, 1);

  const missing = await makeRepo("missing");
  await missing.transactBusinessChange(
    { entityType: "folio", entityId: "missing-ack", expectedVersion: 0, event: event("present-event", "missing-ack") },
    () => ({ id: "missing-ack", balanceMinor: 50 })
  );
  await missing.claimOutboxBatch({ deviceId: "device-contract", limit: 50 });
  await assert.rejects(missing.acknowledgeOutbox({
    deviceId: "device-contract",
    acknowledgements: [{ eventId: "absent-event", sequence: 1 }]
  }));
  assert.deepEqual(await missing.acknowledgeOutbox({
    deviceId: "device-contract",
    acknowledgements: [{ eventId: "present-event", sequence: 1 }]
  }), { acknowledged: 1 });

  const malformed = await makeRepo("malformed");
  await assert.rejects(
    malformed.transactBusinessChange({
      entityType: "folio", entityId: "malformed-time", expectedVersion: 0,
      event: event("malformed-event", "malformed-time", 1, "2026-11-10T05:30:00+05:30")
    }, () => ({ id: "malformed-time", balanceMinor: 1 })),
    /UTC ISO timestamp/
  );
  assert.equal(await malformed.getEntity("folio", "malformed-time"), null);

  const concurrent = await makeRepo("concurrent");
  const writes = await Promise.allSettled([
    concurrent.transactBusinessChange(
      { entityType: "folio", entityId: "concurrent-row", expectedVersion: 0, event: event("concurrent-a", "concurrent-row") },
      () => ({ id: "concurrent-row", balanceMinor: 100 })
    ),
    concurrent.transactBusinessChange(
      { entityType: "folio", entityId: "concurrent-row", expectedVersion: 0, event: event("concurrent-b", "concurrent-row") },
      () => ({ id: "concurrent-row", balanceMinor: 200 })
    )
  ]);
  assert.equal(writes.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(writes.filter(result => result.status === "rejected" && result.reason?.code === "ENTITY_VERSION_CONFLICT").length, 1);
  assert.equal((await concurrent.getEntity("folio", "concurrent-row")).version, 1);
  assert.equal((await concurrent.claimOutboxBatch({ deviceId: "device-contract", limit: 50 })).length, 1);

  const interrupted = await makeRepo("interrupted");
  await assert.rejects(
    interrupted.transactBusinessChange(
      { entityType: "folio", entityId: "interrupted-row", expectedVersion: 0, event: event("interrupted-event", "interrupted-row") },
      () => { throw new Error("injected_mid_transaction_failure"); }
    ),
    /injected_mid_transaction_failure/
  );
  assert.equal(await interrupted.getEntity("folio", "interrupted-row"), null);
  assert.deepEqual(await interrupted.claimOutboxBatch({ deviceId: "device-contract", limit: 50 }), []);

  return Object.freeze({ duplicate: true, missing: true, malformed: true, concurrent: true, interrupted: true });
}
