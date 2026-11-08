/**
 * Resumable, non-destructive projection of the verified legacy PMS snapshot
 * into domain entities. This is migration groundwork, NOT the UI cutover switch.
 *
 * Each batch is atomic (entity + outbox); the overall projection is resumable.
 * The legacy snapshot remains the recovery authority until a separate,
 * verified read-path cutover has been accepted.
 */
const clone = value => value == null ? value :
  (typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value)));
const stable = value => Array.isArray(value) ? value.map(stable) :
  value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
    : value;
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const sameProjectedEntity = (a, b) => {
  const clean = value => {
    const copy = clone(value);
    if (copy && typeof copy === "object" && !Array.isArray(copy)) {
      delete copy.id; delete copy.updatedAt; delete copy.legacySource;
    }
    return copy;
  };
  return same(clean(a), clean(b));
};
const safeId = (value, label) => {
  const id = String(value ?? "").trim();
  if (!id || id.length > 180 || /[\u0000-\u001f]/.test(id)) {
    throw new Error("Legacy " + label + " has no safe stable identity; projection stopped without rewriting it.");
  }
  return id;
};
const paise = value => {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n < 0 || !Number.isSafeInteger(Math.round(n * 100)) ||
      Math.abs(n * 100 - Math.round(n * 100)) > 1e-7) {
    throw new Error("Legacy monetary value is malformed; accounting projection stopped.");
  }
  return Math.round(n * 100);
};

function records(snapshot, migrationId) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new TypeError("A parsed legacy PMS snapshot is required.");
  for (const key of ["rooms", "b", "g", "inv", "exp", "led", "aud"]) {
    if (!Array.isArray(snapshot[key])) throw new Error("Legacy snapshot is missing " + key + ".");
  }
  const rows = [];
  const add = (entityType, entityId, data, source) => rows.push({
    entityType, entityId, data: clone(data),
    eventType: "legacy.domain_projection",
    eventPayload: { migrationId, sourceCollection: source, sourceId: entityId }
  });

  snapshot.rooms.forEach((row, index) => {
    if (!row || typeof row !== "object") throw new Error("Malformed legacy room at index " + index);
    const id = safeId(row.id ?? row.n, "room identity");
    add("room", id, { ...clone(row), id, legacySource: "rooms" }, "rooms");
  });
  snapshot.g.forEach((row, index) => {
    if (!row || typeof row !== "object") throw new Error("Malformed legacy guest at index " + index);
    const id = safeId(row.id ?? "legacy-guest-" + index, "guest identity");
    add("guest", id, { ...clone(row), id, legacySource: "g" }, "g");
  });
  snapshot.b.forEach((row, index) => {
    if (!row || typeof row !== "object") throw new Error("Malformed legacy booking at index " + index);
    const id = safeId(row.id, "booking identity");
    add("booking", id, { ...clone(row), id, legacySource: "b" }, "b");
    const folioId = safeId(row.folioId ?? "booking-" + id, "folio identity");
    // Preserve source values verbatim. Do not reconcile p vs pays or infer
    // an opening balance during migration.
    // Legacy financial evidence is retained separately from normalized folios.
    add("audit", "legacy-folio-source:" + folioId, {
      id: folioId, bookingId: id,
      legacyPaidTotal: row.p ?? null,
      legacyPaymentRows: clone(Array.isArray(row.pays) ? row.pays : []),
      legacyPaymentHistory: clone(Array.isArray(row.payments) ? row.payments : []),
      legacyCurrencySymbol: snapshot.set?.cur ?? "₹"
    }, "b");
  });
  snapshot.inv.forEach((row, index) => {
    if (!row || typeof row !== "object") throw new Error("Malformed legacy inventory item at index " + index);
    const id = safeId(row.id ?? "legacy-inventory-" + index, "inventory identity");
    add("inventory", id, { ...clone(row), id, legacySource: "inv" }, "inv");
  });
  snapshot.exp.forEach((row, index) => {
    if (!row || typeof row !== "object") throw new Error("Malformed legacy expense at index " + index);
    const id = safeId(row.id ?? "legacy-expense-" + index, "expense identity");
    add("expense", id, { ...clone(row), id, legacySource: "exp" }, "exp");
  });
  snapshot.led.forEach((row, index) => {
    if (!row || typeof row !== "object") throw new Error("Malformed legacy ledger row at index " + index);
    add("ledger", "legacy-ledger-" + index, { sourceCollection: "led", sourceIndex: index, value: clone(row) }, "led");
  });
  snapshot.aud.forEach((row, index) => {
    if (!row || typeof row !== "object") throw new Error("Malformed legacy audit row at index " + index);
    add("audit", "legacy-audit-" + index, { sourceCollection: "aud", sourceIndex: index, value: clone(row) }, "aud");
  });
  return rows;
}

/**
 * Project records in resumable batches. Existing exact records are accepted;
 * any divergent record is a hard stop requiring reconciliation. No records
 * are deleted, balances repaired, or legacy source values rewritten.
 */
export async function projectLegacyPmsDomains({ bridge, snapshot, migrationId, batchSize = 20 }) {
  if (!bridge || typeof bridge.fetchEntity !== "function" || typeof bridge.mutateEntities !== "function") {
    throw new TypeError("A bound canonical PMS repository bridge is required.");
  }
  const id = safeId(migrationId, "migration ID");
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 20) {
    throw new RangeError("Projection batch size must be between 1 and 20.");
  }
  const planned = records(snapshot, id);
  const manifestId = "legacy-domain-projection:" + id;
  const manifest = {
    migrationId: id,
    status: "VERIFIED",
    recordCount: planned.length,
    counts: planned.reduce((out, row) => (out[row.entityType] = (out[row.entityType] || 0) + 1, out), {}),
    sourceCollections: ["rooms", "g", "b", "inv", "exp", "led", "aud"],
    preservesLegacySnapshot: true,
    financialReconciliationPerformed: false
  };
  const existingManifest = await bridge.fetchEntity("audit", manifestId);
  if (existingManifest) {
    if (!same(existingManifest.data, manifest)) throw new Error("Existing domain projection manifest differs; migration is frozen for reconciliation.");
    return Object.freeze({ alreadyProjected: true, projected: 0, total: planned.length, manifest: existingManifest.data });
  }

  let projected = 0, alreadyPresent = 0;
  for (let offset = 0; offset < planned.length; offset += batchSize) {
    const batch = [];
    for (const row of planned.slice(offset, offset + batchSize)) {
      const current = await bridge.fetchEntity(row.entityType, row.entityId);
      if (current) {
        if (!sameProjectedEntity(current.data, row.data)) {
          throw Object.assign(new Error("Canonical " + row.entityType + " entity " + row.entityId + " differs from the legacy snapshot; projection stopped."), {
            code: "LEGACY_DOMAIN_PROJECTION_DIVERGENCE",
            entityType: row.entityType, entityId: row.entityId
          });
        }
        alreadyPresent++;
        continue;
      }
      batch.push({
        ...row, expectedVersion: 0,
        mutate: entity => { for (const key of Object.keys(entity)) delete entity[key]; Object.assign(entity, clone(row.data)); }
      });
    }
    if (batch.length) {
      if (batch.length === 1) await bridge.mutateEntity(batch[0]);
      else await bridge.mutateEntities(batch);
      projected += batch.length;
      // Exact read-back is required before advancing to the next batch.
      for (const row of batch) {
        const stored = await bridge.fetchEntity(row.entityType, row.entityId);
        if (!stored || stored.version !== 1 || !sameProjectedEntity(stored.data, row.data)) {
          throw Object.assign(new Error("Domain projection read-back failed for " + row.entityType + ":" + row.entityId), {
            code: "LEGACY_DOMAIN_PROJECTION_READBACK_FAILED"
          });
        }
      }
    }
  }
  const committed = await bridge.mutateEntity({
    entityType: "audit", entityId: manifestId, expectedVersion: 0,
    eventType: "legacy.domain_projection_verified",
    eventPayload: { migrationId: id, recordCount: planned.length, counts: manifest.counts },
    mutate: entity => Object.assign(entity, manifest)
  });
  const verify = await bridge.fetchEntity("audit", manifestId);
  if (!verify || verify.version !== 1 || !same(verify.data, manifest)) {
    throw Object.assign(new Error("Projection manifest read-back failed; do not switch application reads."), {
      code: "LEGACY_DOMAIN_PROJECTION_MANIFEST_FAILED"
    });
  }
  return Object.freeze({ alreadyProjected: false, projected, alreadyPresent, total: planned.length, manifest: verify.data });
}
