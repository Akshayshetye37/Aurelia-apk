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
  for (const key of ["rooms", "b", "g", "t", "inv", "exp", "led", "aud"]) {
    if (!Array.isArray(snapshot[key])) throw new Error("Legacy snapshot is missing " + key + ".");
  }
  const rows = [];
  const isPlainObject = value => value !== null && typeof value === "object" &&
    !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  for (const [key, value] of [["set", snapshot.set ?? {}], ["menu", snapshot.menu ?? {}]]) {
    if (!isPlainObject(value)) throw new TypeError("Legacy " + key + " settings must be a plain object.");
  }
  const add = (entityType, entityId, data, source) => rows.push({
    entityType, entityId, data: clone(data),
    eventType: "legacy.domain_projection",
    eventPayload: { migrationId, sourceCollection: source, sourceId: entityId }
  });

  // Property configuration and restaurant menu are business settings, not
  // disposable UI preferences. Keep both source objects intact in one canonical
  // entity so later settings writes have a stable, versioned repository target.
  add("settings", "property-settings", {
    id: "property-settings",
    set: clone(snapshot.set ?? {}),
    menu: clone(snapshot.menu ?? {})
  }, "set/menu");

  snapshot.rooms.forEach((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Malformed legacy room at index " + index);
    const id = safeId(row.id ?? row.n ?? row.room ?? row.roomNo, "room identity");
    const roomNumber = row.n ?? row.room ?? row.roomNo ?? id;
    const rate = Number(row.r ?? row.rate ?? 0);
    if (!Number.isFinite(rate) || rate < 0 || Math.abs(rate * 100 - Math.round(rate * 100)) > 1e-7) {
      throw new Error("Legacy room rate is malformed; projection stopped.");
    }
    const data = {
      id,
      n: typeof roomNumber === "number" ? roomNumber : String(roomNumber),
      t: String(row.t ?? row.type ?? "Room"),
      r: rate,
      s: row.s ?? "ready"
    };
    if (row.demo === true) data.demo = true;
    if (row.status_changed !== undefined) data.status_changed = row.status_changed;
    add("room", id, data, "rooms");
  });
  snapshot.g.forEach((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Malformed legacy guest at index " + index);
    const id = safeId(row.id ?? "legacy-guest-" + index, "guest identity");
    const name = safeId(row.n ?? row.name ?? row.guestName ?? row.fullName, "guest name");
    const data = {
      id,
      n: name,
      ph: String(row.ph ?? row.phone ?? ""),
      em: String(row.em ?? row.email ?? ""),
      idt: String(row.idt ?? row.idType ?? ""),
      idn: String(row.idn ?? row.idNumber ?? ""),
      occ: Array.isArray(row.occ) ? row.occ.map(person => ({
        n: String(person?.n ?? ""), dob: String(person?.dob ?? ""), rel: String(person?.rel ?? "")
      })) : [],
      veh: Array.isArray(row.veh) ? row.veh.map(vehicle => ({
        reg: String(vehicle?.reg ?? ""), ty: String(vehicle?.ty ?? "")
      })) : []
    };
    if (typeof row.img === "string") data.img = row.img;
    if (typeof row.imgKey === "string") data.imgKey = row.imgKey;
    if (row.demo === true) data.demo = true;
    add("guest", id, data, "g");
  });
  snapshot.b.forEach((row, index) => {
    if (!row || typeof row !== "object") throw new Error("Malformed legacy booking at index " + index);
    const id = safeId(row.id, "booking identity");
    add("booking", id, { ...clone(row), id }, "b");
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
  const tableIds = new Set();
  snapshot.t.forEach((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("Malformed legacy restaurant table at index " + index);
    }
    const tableNumber = Number(row.n);
    if (!Number.isSafeInteger(tableNumber) || tableNumber < 1) {
      throw new Error("Legacy restaurant table has no safe positive integer table number at index " + index);
    }
    const id = safeId(tableNumber, "restaurant table identity");
    if (tableIds.has(id)) throw new Error("Legacy restaurant table numbers are duplicated; projection stopped.");
    tableIds.add(id);
    add("restaurant_table", id, clone(row), "t");
  });
  const sales = snapshot.sales === undefined ? [] : snapshot.sales;
  if (!Array.isArray(sales)) throw new TypeError("Legacy restaurant sales must be an array.");
  const saleIds = new Set();
  sales.forEach((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("Malformed legacy restaurant sale at index " + index);
    }
    const id = safeId(row.id ?? ("legacy-restaurant-sale-" + (index + 1)), "restaurant sale identity");
    if (saleIds.has(id)) throw new Error("Legacy restaurant sale IDs are duplicated; projection stopped.");
    saleIds.add(id);
    add("restaurant_sale", id, { ...clone(row), id }, "sales");
  });
  snapshot.inv.forEach((row, index) => {
    if (!row || typeof row !== "object") throw new Error("Malformed legacy inventory item at index " + index);
    const id = safeId(row.id ?? "legacy-inventory-" + index, "inventory identity");
    add("inventory", id, { ...clone(row), id }, "inv");
  });
  snapshot.exp.forEach((row, index) => {
    if (!row || typeof row !== "object") throw new Error("Malformed legacy expense at index " + index);
    const id = safeId(row.id ?? "legacy-expense-" + index, "expense identity");
    add("expense", id, { ...clone(row), id }, "exp");
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
  if (!bridge || typeof bridge.fetchEntity !== "function" || typeof bridge.mutateEntities !== "function" || typeof bridge.mutateEntity !== "function") {
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
    sourceCollections: ["set", "menu", "rooms", "g", "b", "t", "sales", "inv", "exp", "led", "aud"],
    preservesLegacySnapshot: true,
    financialReconciliationPerformed: false
  };
  const existingManifest = await bridge.fetchEntity("audit", manifestId);
  let alreadyPresent = 0;
  let projectionRows = planned;
  if (existingManifest) {
    const previous = existingManifest.data;
    const previousCounts = previous?.counts;
    const previousCollections = previous?.sourceCollections;
    if (!previous || previous.migrationId !== id || previous.status !== "VERIFIED" ||
        previous.preservesLegacySnapshot !== true || previous.financialReconciliationPerformed !== false ||
        !previousCounts || typeof previousCounts !== "object" || Array.isArray(previousCounts) ||
        !Array.isArray(previousCollections) ||
        previousCollections.some(collection => !manifest.sourceCollections.includes(collection))) {
      throw new Error("Existing domain projection manifest is invalid or incompatible; migration is frozen for reconciliation.");
    }
    for (const [entityType, count] of Object.entries(previousCounts)) {
      if (!Number.isSafeInteger(count) || count < 0 || manifest.counts[entityType] !== count) {
        throw new Error("Existing domain projection counts differ from the immutable source snapshot; migration is frozen for reconciliation.");
      }
    }
    const previousTypes = new Set(Object.keys(previousCounts));
    projectionRows = [];
    // Earlier projection versions may not have known about newly added domains.
    // Preserve existing canonical rows for old domains; only add missing rows
    // for newly introduced entity types. Never replay an old snapshot over live data.
    for (const row of planned) {
      const current = await bridge.fetchEntity(row.entityType, row.entityId);
      if (previousTypes.has(row.entityType)) {
        if (!current) {
          throw Object.assign(new Error("Previously verified canonical " + row.entityType + " entity " + row.entityId + " is missing; recovery is required."), {
            code: "LEGACY_DOMAIN_PROJECTION_MISSING_ENTITY",
            entityType: row.entityType, entityId: row.entityId
          });
        }
        alreadyPresent++;
        continue;
      }
      if (current) {
        alreadyPresent++;
        continue;
      }
      projectionRows.push(row);
    }
    if (same(previous, manifest)) {
      return Object.freeze({ alreadyProjected: true, projected: 0, alreadyPresent, total: planned.length, manifest: previous });
    }
  }

  let projected = 0;
  for (let offset = 0; offset < projectionRows.length; offset += batchSize) {
    const batch = [];
    for (const row of projectionRows.slice(offset, offset + batchSize)) {
      const current = await bridge.fetchEntity(row.entityType, row.entityId);
      if (current) {
        if (!existingManifest && !sameProjectedEntity(current.data, row.data)) {
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
        mutate: entity => {
          for (const key of Object.keys(entity)) delete entity[key];
          Object.assign(entity, clone(row.data));
          return entity;
        }
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
  const expectedManifestVersion = existingManifest?.version ?? 0;
  await bridge.mutateEntity({
    entityType: "audit", entityId: manifestId, expectedVersion: expectedManifestVersion,
    eventType: existingManifest ? "legacy.domain_projection_extended" : "legacy.domain_projection_verified",
    eventPayload: { migrationId: id, recordCount: planned.length, counts: manifest.counts },
    mutate: entity => {
      for (const key of Object.keys(entity)) delete entity[key];
      Object.assign(entity, manifest);
      return entity;
    }
  });
  const verify = await bridge.fetchEntity("audit", manifestId);
  if (!verify || verify.version !== expectedManifestVersion + 1 || !same(verify.data, manifest)) {
    throw Object.assign(new Error("Projection manifest read-back failed; do not switch application reads."), {
      code: "LEGACY_DOMAIN_PROJECTION_MANIFEST_FAILED"
    });
  }
  return Object.freeze({
    alreadyProjected: false, projected, alreadyPresent, total: planned.length, manifest: verify.data
  });
}
