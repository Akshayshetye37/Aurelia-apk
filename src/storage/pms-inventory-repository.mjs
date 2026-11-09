/**
 * Canonical inventory projection and stock mutation boundary.
 *
 * Inventory rows and the complete recovery snapshot are committed together.
 * Existing stock entities are never silently recreated from a stale snapshot;
 * removed rows are tombstoned so stock history and outbox identity survive.
 */
const clone = value => typeof structuredClone === "function"
  ? structuredClone(value)
  : JSON.parse(JSON.stringify(value));
const stable = value => value instanceof Date ? value.toISOString() :
  Array.isArray(value) ? value.map(stable) :
  value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
    : value;
const comparable = value => {
  const copy = clone(value);
  if (copy && typeof copy === "object" && !Array.isArray(copy)) {
    delete copy.updatedAt;
    delete copy.retiredAt;
    delete copy.retired;
  }
  return copy;
};
const same = (left, right) => JSON.stringify(stable(comparable(left))) === JSON.stringify(stable(comparable(right)));
const inventoryId = (row, index) => {
  const id = String(row?.id ?? "legacy-inventory-" + index);
  if (!id.trim() || id.length > 180 || /[\u0000-\u001f]/.test(id)) {
    throw new TypeError("Inventory item requires a stable valid ID.");
  }
  return id;
};
const retired = row => row?.data?.retired === true || row?.data?.status === "retired";

const stableString = value => JSON.stringify(stable(value));
const movementHash = value => {
  const input = stableString(value);
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
};
const movementRows = (snapshot, previous) => {
  const nextRows = Array.isArray(snapshot.led) ? snapshot.led : [];
  const priorRows = Array.isArray(previous?.led) ? previous.led : [];
  const priorCounts = new Map();
  const nextCounts = new Map();
  for (const row of priorRows) {
    const key = stableString(row);
    priorCounts.set(key, (priorCounts.get(key) || 0) + 1);
  }
  for (const row of nextRows) {
    const key = stableString(row);
    nextCounts.set(key, (nextCounts.get(key) || 0) + 1);
  }
  for (const [key, count] of priorCounts) {
    if ((nextCounts.get(key) || 0) < count) {
      throw Object.assign(new Error("Inventory movement ledger is append-only; existing movement rows cannot be removed or edited."), {
        code: "INVENTORY_MOVEMENT_HISTORY_MUTATION"
      });
    }
  }
  const additions = [];
  for (const row of nextRows) {
    const key = stableString(row);
    const seen = additions.filter(entry => entry.key === key).length;
    const already = priorCounts.get(key) || 0;
    if (seen + 1 > (nextCounts.get(key) || 0) - already) continue;
    additions.push({ key, row: clone(row), ordinal: already + seen + 1 });
  }
  return additions;
};

function validateItem(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new TypeError("Inventory item must be a plain object.");
  if (!Number.isSafeInteger(Number(row.q)) || Number(row.q) < 0 ||
      !Number.isSafeInteger(Number(row.ro)) || Number(row.ro) < 0) {
    throw new TypeError("Inventory quantity and reorder level must be non-negative whole units.");
  }
  for (const value of [row.u, row.price]) {
    if (value != null && (!Number.isFinite(Number(value)) || Number(value) < 0 ||
        !Number.isSafeInteger(Math.round(Number(value) * 100)) ||
        Math.abs(Number(value) * 100 - Math.round(Number(value) * 100)) > 1e-7)) {
      throw new TypeError("Inventory unit cost and sell price must be non-negative with at most two decimal places.");
    }
  }
}

export class PmsInventoryRepository {
  constructor({ bridge, now = () => new Date().toISOString() } = {}) {
    if (!bridge || typeof bridge.fetchEntity !== "function" ||
        typeof bridge.listEntities !== "function" || typeof bridge.mutateEntities !== "function") {
      throw new TypeError("A bound transactional PMS repository bridge is required.");
    }
    this.bridge = bridge;
    this.now = now;
    this.writeQueue = Promise.resolve();
    this.knownVersions = null;
  }

  async list() {
    const rows = await this.bridge.listEntities("inventory");
    if (!Array.isArray(rows)) throw new Error("Canonical inventory repository returned an invalid entity list.");
    const active = [];
    const ids = new Set();
    for (const row of rows) {
      if (!row || row.type !== "inventory" || typeof row.id !== "string" ||
          !Number.isSafeInteger(row.version) || row.version < 1 ||
          !row.data || typeof row.data !== "object" || Array.isArray(row.data)) {
        throw new Error("Canonical inventory contains an invalid entity.");
      }
      if (row.data.id !== row.id || ids.has(row.id)) {
        throw new Error("Canonical inventory contains a duplicate or unstable identity.");
      }
      ids.add(row.id);
      validateItem(row.data);
      if (!retired(row)) active.push(clone(row.data));
    }
    return active;
  }

  async hydrateSnapshot(snapshot, { enabled = true } = {}) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || !Array.isArray(snapshot.inv)) {
      throw new TypeError("A complete PMS snapshot with an inventory collection is required.");
    }
    const hydrated = clone(snapshot);
    if (!enabled) return hydrated;
    const rows = await this.bridge.listEntities("inventory");
    if (!Array.isArray(rows)) throw new Error("Canonical inventory repository returned an invalid entity list.");
    this.knownVersions = new Map(rows.map(row => [row.id, row.version]));
    const canonical = await this.list();
    if (!canonical.length && hydrated.inv.length) {
      throw new Error("Canonical inventory entities are missing for the verified migration.");
    }
    const byId = new Map(canonical.map(row => [String(row.id), row]));
    const used = new Set();
    const ordered = [];
    hydrated.inv.forEach((row, index) => {
      const id = inventoryId(row, index);
      const stored = byId.get(id);
      if (!stored) throw Object.assign(new Error("Canonical inventory item " + id + " is missing; recovery is required."), {
        code: "INVENTORY_ENTITY_MISSING", inventoryId: id
      });
      ordered.push(clone(stored));
      used.add(id);
    });
    for (const row of canonical) if (!used.has(String(row.id))) ordered.push(clone(row));
    hydrated.inv = ordered;
    return hydrated;
  }

  syncSnapshot(snapshot) {
    const operation = () => this.#syncSnapshot(snapshot);
    const pending = this.writeQueue.then(operation, operation);
    this.writeQueue = pending.catch(() => {});
    return pending;
  }

  async #syncSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || !Array.isArray(snapshot.inv)) {
      throw new TypeError("A complete PMS snapshot with an inventory collection is required.");
    }
    const desired = new Map();
    snapshot.inv.forEach((row, index) => {
      validateItem(row);
      const id = inventoryId(row, index);
      if (desired.has(id)) throw new Error("Inventory item IDs must be unique.");
      desired.set(id, { id, data: { ...clone(row), id } });
    });

    const rows = await this.bridge.listEntities("inventory");
    if (!Array.isArray(rows)) throw new Error("Canonical inventory repository returned an invalid entity list.");
    const current = new Map();
    for (const row of rows) {
      if (!row || row.type !== "inventory" || typeof row.id !== "string" ||
          !Number.isSafeInteger(row.version) || row.version < 1 ||
          !row.data || typeof row.data !== "object" || Array.isArray(row.data) ||
          row.data.id !== row.id || current.has(row.id)) {
        throw new Error("Canonical inventory contains an invalid or duplicate entity.");
      }
      validateItem(row.data);
      current.set(row.id, row);
    }

    if (this.knownVersions === null) {
      this.knownVersions = new Map([...current].map(([id, row]) => [id, row.version]));
    }
    for (const [id, row] of current) {
      if (this.knownVersions.get(id) !== row.version) {
        throw Object.assign(new Error("Inventory item " + id + " changed in another session; reload before writing stock."), {
          code: "INVENTORY_VERSION_CONFLICT", inventoryId: id,
          expectedVersion: this.knownVersions.get(id) ?? 0, actualVersion: row.version
        });
      }
    }

    const snapshotRow = await this.bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2");
    if (snapshotRow) {
      const prior = snapshotRow.data?.snapshot;
      if (!prior || (prior.inv !== undefined && !Array.isArray(prior.inv)) ||
          (prior.inv === undefined && current.size > 0)) {
        throw new Error("Canonical recovery snapshot has no valid inventory collection.");
      }
      const priorById = new Map();
      (prior.inv || []).forEach((row, index) => {
        const id = inventoryId(row, index);
        if (priorById.has(id)) throw new Error("Canonical recovery snapshot contains duplicate inventory IDs.");
        priorById.set(id, { ...clone(row), id });
      });
      for (const [id, row] of current) {
        const previous = priorById.get(id);
        if (retired(row)) {
          if (previous) throw Object.assign(new Error("Inventory retirement differs from the recovery snapshot."), {
            code: "INVENTORY_SNAPSHOT_DIVERGENCE", inventoryId: id
          });
          continue;
        }
        if (!previous || !same(row.data, previous)) {
          throw Object.assign(new Error("Canonical inventory item " + id + " differs from the recovery snapshot; refusing a stale overwrite."), {
            code: "INVENTORY_SNAPSHOT_DIVERGENCE", inventoryId: id
          });
        }
        priorById.delete(id);
      }
      if (priorById.size) {
        const missing = priorById.keys().next().value;
        throw Object.assign(new Error("Canonical inventory item " + missing + " is missing although the recovery snapshot still references it."), {
          code: "INVENTORY_ENTITY_MISSING", inventoryId: missing
        });
      }
    } else if (current.size) {
      throw Object.assign(new Error("Cannot mutate inventory before a canonical recovery snapshot exists."), {
        code: "CANONICAL_SNAPSHOT_MISSING"
      });
    }

    const newMovements = snapshotRow
      ? movementRows(snapshot, snapshotRow.data.snapshot)
      : [];

    const tableChanges = [];
    if (snapshotRow) {
      const priorTables = snapshotRow.data.snapshot?.t;
      if (!Array.isArray(priorTables) || !Array.isArray(snapshot.t)) {
        throw new Error("Canonical recovery snapshot has no valid restaurant table collection.");
      }
      const priorById = new Map();
      for (const row of priorTables) {
        const number = Number(row?.n);
        if (!Number.isSafeInteger(number) || number < 1 || priorById.has(String(number))) {
          throw new Error("Canonical recovery snapshot contains an invalid or duplicate restaurant table.");
        }
        priorById.set(String(number), row);
      }
      const currentTables = await this.bridge.listEntities("restaurant_table");
      if (!Array.isArray(currentTables)) throw new Error("Canonical restaurant table repository returned an invalid entity list.");
      const currentById = new Map();
      for (const row of currentTables) {
        const number = Number(row?.data?.n);
        if (!row || row.type !== "restaurant_table" || !Number.isSafeInteger(number) ||
            number < 1 || row.id !== String(number) || currentById.has(row.id)) {
          throw new Error("Canonical restaurant table inventory contains an invalid entity.");
        }
        currentById.set(row.id, row);
      }
      for (const [id, prior] of priorById) {
        const stored = currentById.get(id);
        if (!stored || !same(stored.data, prior)) {
          throw Object.assign(new Error("Restaurant table " + id + " changed in another session; reload before stock/order mutation."), {
            code: "RESTAURANT_TABLE_VERSION_CONFLICT", tableId: id
          });
        }
      }
      const desiredTables = new Map();
      for (const row of snapshot.t) {
        const number = Number(row?.n);
        if (!Number.isSafeInteger(number) || number < 1 || desiredTables.has(String(number))) {
          throw new Error("Requested restaurant table snapshot contains an invalid or duplicate table.");
        }
        desiredTables.set(String(number), clone(row));
      }
      for (const [id, data] of desiredTables) {
        const old = currentById.get(id);
        if (old && (old.data.retired === true || old.data.status === "retired")) {
          throw Object.assign(new Error("Retired restaurant table IDs cannot be reused."), {
            code: "RESTAURANT_TABLE_ID_RETIRED", tableId: id
          });
        }
        if (old && same(old.data, data)) continue;
        tableChanges.push({
          entityType: "restaurant_table", entityId: id, expectedVersion: old?.version ?? 0,
          eventType: old ? "restaurant.table_order_updated" : "restaurant.table_created",
          eventPayload: { tableId: id, operation: old ? "update" : "create", source: "inventory_mutation" },
          mutate: entity => {
            for (const key of Object.keys(entity)) delete entity[key];
            Object.assign(entity, clone(data), { updatedAt: this.now() });
            return entity;
          }
        });
      }
    }
    const movementChanges = [];
    for (const change of tableChanges) {
      const stored = await this.bridge.fetchEntity("restaurant_table", change.entityId);
      const expected = snapshot.t.find(row => String(row?.n) === change.entityId);
      if (!stored || !expected || !same(stored.data, expected)) {
        throw Object.assign(new Error("Restaurant table order failed exact canonical read-back."), {
          code: "RESTAURANT_TABLE_READBACK_FAILED", tableId: change.entityId
        });
      }
    }
    for (const movement of newMovements) {
      const id = "inventory-movement-" + movementHash(movement.row) + "-" + movement.ordinal;
      const data = {
        kind: "inventory_movement",
        source: "inventory_snapshot_ledger",
        value: movement.row
      };
      const existing = await this.bridge.fetchEntity("ledger", id);
      if (existing) {
        if (!same(existing.data, data)) {
          throw Object.assign(new Error("Inventory movement identity collision; refusing to overwrite ledger history."), {
            code: "INVENTORY_MOVEMENT_ID_COLLISION", movementId: id
          });
        }
        continue;
      }
      movementChanges.push({
        entityType: "ledger", entityId: id, expectedVersion: 0,
        eventType: "inventory.movement_recorded",
        eventPayload: { movementId: id, source: "inventory_snapshot_ledger" },
        mutate: entity => Object.assign(entity, clone(data), { createdAt: this.now() })
      });
    }

    const changes = [];
    for (const [id, target] of desired) {
      const old = current.get(id);
      if (old && retired(old)) {
        throw Object.assign(new Error("Retired inventory IDs cannot be reused; create a new item ID."), {
          code: "INVENTORY_ID_RETIRED", inventoryId: id
        });
      }
      if (old && same(old.data, target.data)) continue;
      changes.push({
        entityType: "inventory", entityId: id, expectedVersion: old?.version ?? 0,
        eventType: old ? "inventory.updated" : "inventory.created",
        eventPayload: { inventoryId: id, operation: old ? "update" : "create" },
        mutate: entity => {
          for (const key of Object.keys(entity)) delete entity[key];
          Object.assign(entity, clone(target.data), { updatedAt: this.now() });
          return entity;
        }
      });
    }
    for (const [id, old] of current) {
      if (desired.has(id) || retired(old)) continue;
      const retiredAt = this.now();
      const data = { ...clone(old.data), retired: true, retiredAt, updatedAt: retiredAt };
      changes.push({
        entityType: "inventory", entityId: id, expectedVersion: old.version,
        eventType: "inventory.retired",
        eventPayload: { inventoryId: id, operation: "retire" },
        mutate: entity => {
          for (const key of Object.keys(entity)) delete entity[key];
          Object.assign(entity, clone(data));
          return entity;
        }
      });
    }
    if (changes.length + movementChanges.length + tableChanges.length > 19) {
      throw new RangeError("Inventory, table and movement changes exceed the 19-entity atomic transaction limit.");
    }
    if (changes.length || movementChanges.length || tableChanges.length) {
      const committedAt = this.now();
      const auditChange = {
        entityType: "audit", entityId: "legacy_snapshot:aurelia_lodge_v2",
        expectedVersion: snapshotRow?.version ?? 0,
        eventType: "pms.snapshot_inventory_mutation",
        eventPayload: { inventoryCount: desired.size, changedInventory: changes.map(change => change.entityId), tableCount: tableChanges.length, movementCount: movementChanges.length },
        mutate: entity => {
          entity.sourceKey = "aurelia_lodge_v2";
          entity.snapshot = clone(snapshot);
          entity.updatedAt = committedAt;
          return entity;
        }
      };
      await this.bridge.mutateEntities([...changes, ...tableChanges, ...movementChanges, auditChange]);
    }

    const active = await this.list();
    if (active.length !== desired.size) throw new Error("Inventory repository read-back count does not match the requested snapshot.");
    for (const [id, target] of desired) {
      const stored = await this.bridge.fetchEntity("inventory", id);
      if (!stored || retired(stored) || !same(stored.data, target.data)) {
        throw Object.assign(new Error("Inventory commit failed exact read-back for " + id + "."), {
          code: "INVENTORY_READBACK_FAILED", inventoryId: id
        });
      }
    }
    const finalRows = await this.bridge.listEntities("inventory");
    this.knownVersions = new Map(finalRows.map(row => [row.id, row.version]));
    for (const movement of newMovements) {
      const id = "inventory-movement-" + movementHash(movement.row) + "-" + movement.ordinal;
      const stored = await this.bridge.fetchEntity("ledger", id);
      if (!stored || !same({
        kind: stored.data.kind, source: stored.data.source, value: stored.data.value
      }, {
        kind: "inventory_movement", source: "inventory_snapshot_ledger", value: movement.row
      })) {
        throw Object.assign(new Error("Inventory movement failed exact canonical ledger read-back."), {
          code: "INVENTORY_MOVEMENT_READBACK_FAILED", movementId: id
        });
      }
    }
    if (changes.length || movementChanges.length || tableChanges.length) {
      const storedSnapshot = await this.bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2");
      if (!storedSnapshot || !same(storedSnapshot.data.snapshot, snapshot)) {
        throw Object.assign(new Error("Inventory transaction failed exact recovery snapshot read-back."), {
          code: "INVENTORY_SNAPSHOT_READBACK_FAILED"
        });
      }
    }
    return Object.freeze({ count: active.length, changed: changes.length, items: active });
  }
}
