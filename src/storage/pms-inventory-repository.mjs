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
  const id = row?.id ?? "legacy-inventory-" + index;
  if (typeof id !== "string" || !id.trim() || id.length > 180 || /[\u0000-\u001f]/.test(id)) {
    throw new TypeError("Inventory item requires a stable valid ID.");
  }
  return id;
};
const retired = row => row?.data?.retired === true || row?.data?.status === "retired";

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
      if (row.id !== String(row.data.id || row.id) || ids.has(row.id)) {
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
          row.id !== String(row.data.id || row.id) || current.has(row.id)) {
        throw new Error("Canonical inventory contains an invalid or duplicate entity.");
      }
      validateItem(row.data);
      current.set(row.id, row);
    }

    const snapshotRow = await this.bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2");
    if (snapshotRow) {
      const prior = snapshotRow.data?.snapshot;
      if (!prior || !Array.isArray(prior.inv)) {
        throw new Error("Canonical recovery snapshot has no valid inventory collection.");
      }
      const priorById = new Map();
      prior.inv.forEach((row, index) => {
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

    const changes = [];
    for (const [id, target] of desired) {
      const old = current.get(id);
      if (old && !retired(old) && same(old.data, target.data)) continue;
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
    if (changes.length > 19) {
      throw new RangeError("Inventory snapshot changes exceed the 19-item atomic transaction limit.");
    }
    if (changes.length) {
      const committedAt = this.now();
      const auditChange = {
        entityType: "audit", entityId: "legacy_snapshot:aurelia_lodge_v2",
        expectedVersion: snapshotRow?.version ?? 0,
        eventType: "pms.snapshot_inventory_mutation",
        eventPayload: { inventoryCount: desired.size, changedInventory: changes.map(change => change.entityId) },
        mutate: entity => {
          entity.sourceKey = "aurelia_lodge_v2";
          entity.snapshot = clone(snapshot);
          entity.updatedAt = committedAt;
          return entity;
        }
      };
      await this.bridge.mutateEntities([...changes, auditChange]);
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
    if (changes.length) {
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
