/**
 * Canonical local repository for restaurant table configuration and open orders.
 * Table identity is the stable positive table number; removed tables are
 * tombstoned so historical references are never silently reused or deleted.
 */
const clone = value => typeof structuredClone === "function"
  ? structuredClone(value)
  : JSON.parse(JSON.stringify(value));
const stable = value => Array.isArray(value) ? value.map(stable) :
  value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
    : value;
const clean = value => {
  const copy = clone(value);
  if (copy && typeof copy === "object" && !Array.isArray(copy)) delete copy.updatedAt;
  return copy;
};
const same = (left, right) => JSON.stringify(stable(clean(left))) === JSON.stringify(stable(clean(right)));
const tableNumber = row => {
  const number = Number(row?.n);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError("Restaurant table number must be a positive safe integer.");
  }
  return number;
};
const tableId = number => String(number);
const isRetired = row => row?.data?.retired === true || row?.data?.status === "retired";

export class PmsRestaurantTableRepository {
  constructor({ bridge, now = () => new Date().toISOString() } = {}) {
    if (!bridge || typeof bridge.fetchEntity !== "function" ||
        typeof bridge.listEntities !== "function" || typeof bridge.mutateEntity !== "function" ||
        typeof bridge.mutateEntities !== "function") {
      throw new TypeError("A bound transactional PMS repository bridge is required.");
    }
    this.bridge = bridge;
    this.now = now;
    this.writeQueue = Promise.resolve();
  }

  async list() {
    const rows = await this.bridge.listEntities("restaurant_table");
    if (!Array.isArray(rows)) throw new Error("Canonical restaurant table repository returned an invalid entity list.");
    const active = [];
    const seen = new Set();
    for (const row of rows) {
      if (!row || row.type !== "restaurant_table" || typeof row.id !== "string" ||
          !Number.isSafeInteger(row.version) || row.version < 1 ||
          !row.data || typeof row.data !== "object" || Array.isArray(row.data)) {
        throw new Error("Canonical restaurant table inventory contains an invalid entity.");
      }
      const number = tableNumber(row.data);
      if (row.id !== tableId(number) || seen.has(number)) {
        throw new Error("Canonical restaurant table inventory contains a duplicate or unstable table identity.");
      }
      seen.add(number);
      if (!isRetired(row)) active.push(clean(row.data));
    }
    return active.sort((a, b) => Number(a.n) - Number(b.n));
  }

  async hydrateSnapshot(snapshot, { enabled = true } = {}) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || !Array.isArray(snapshot.t)) {
      throw new TypeError("A complete PMS snapshot with a restaurant table collection is required.");
    }
    const hydrated = clone(snapshot);
    if (!enabled) return hydrated;
    const rows = await this.bridge.listEntities("restaurant_table");
    if (!Array.isArray(rows)) throw new Error("Canonical restaurant table repository returned an invalid entity list.");
    if (!rows.length && hydrated.t.length) {
      throw new Error("Canonical restaurant table entities are missing for the verified migration.");
    }
    // Canonical entities intentionally win over the compatibility snapshot:
    // a process may have died after the table transaction but before snapshot refresh.
    hydrated.t = await this.list();
    return hydrated;
  }

  syncSnapshot(snapshot) {
    const operation = () => this.#syncSnapshot(snapshot);
    const pending = this.writeQueue.then(operation, operation);
    this.writeQueue = pending.catch(() => {});
    return pending;
  }

  async #syncSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || !Array.isArray(snapshot.t)) {
      throw new TypeError("A complete PMS snapshot with a restaurant table collection is required.");
    }
    const desired = new Map();
    for (const row of snapshot.t) {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw new TypeError("Restaurant table snapshot contains a malformed row.");
      }
      const number = tableNumber(row);
      if (desired.has(number)) throw new Error("Restaurant table numbers must be unique.");
      desired.set(number, { id: tableId(number), data: clone(row) });
    }

    const currentRows = await this.bridge.listEntities("restaurant_table");
    if (!Array.isArray(currentRows)) throw new Error("Canonical restaurant table repository returned an invalid entity list.");
    const current = new Map();
    for (const row of currentRows) {
      if (!row || row.type !== "restaurant_table" || typeof row.id !== "string" ||
          !Number.isSafeInteger(row.version) || row.version < 1 ||
          !row.data || typeof row.data !== "object" || Array.isArray(row.data)) {
        throw new Error("Canonical restaurant table inventory contains an invalid entity.");
      }
      const number = tableNumber(row.data);
      if (row.id !== tableId(number) || current.has(number)) {
        throw new Error("Canonical restaurant table inventory contains a duplicate or unstable table identity.");
      }
      current.set(number, row);
    }

    const snapshotRow = await this.bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2");
    if (snapshotRow) {
      const priorSnapshot = snapshotRow.data?.snapshot;
      if (!priorSnapshot || !Array.isArray(priorSnapshot.t)) {
        throw new Error("Canonical recovery snapshot has no valid restaurant table collection.");
      }
      const priorTables = new Map();
      for (const row of priorSnapshot.t) {
        const number = tableNumber(row);
        if (priorTables.has(number)) throw new Error("Canonical recovery snapshot contains duplicate restaurant table numbers.");
        priorTables.set(number, row);
      }
      for (const [number, row] of current) {
        const prior = priorTables.get(number);
        if (isRetired(row)) {
          if (prior) throw Object.assign(new Error("Canonical restaurant table retirement differs from the recovery snapshot."), {
            code: "RESTAURANT_TABLE_SNAPSHOT_DIVERGENCE", tableNumber: number
          });
          continue;
        }
        if (!prior || !same(row.data, prior)) {
          throw Object.assign(new Error("Canonical restaurant table " + number + " differs from the recovery snapshot; refusing a non-atomic repair."), {
            code: "RESTAURANT_TABLE_SNAPSHOT_DIVERGENCE", tableNumber: number
          });
        }
        priorTables.delete(number);
      }
      if (priorTables.size) {
        const missingNumber = priorTables.keys().next().value;
        throw Object.assign(new Error("Canonical restaurant table " + missingNumber + " is missing although the recovery snapshot still references it."), {
          code: "RESTAURANT_TABLE_ENTITY_MISSING", tableNumber: missingNumber
        });
      }
    } else {
      for (const [number, row] of current) {
        if (!isRetired(row) && !desired.has(number)) {
          throw Object.assign(new Error("Cannot remove an existing restaurant table before a recovery snapshot has been established."), {
            code: "RESTAURANT_TABLE_SNAPSHOT_MISSING", tableNumber: number
          });
        }
      }
    }

    const changes = [];
    for (const [number, target] of desired) {
      const old = current.get(number);
      if (old && !isRetired(old) && same(old.data, target.data)) continue;
      changes.push({
        entityType: "restaurant_table",
        entityId: target.id,
        expectedVersion: old?.version ?? 0,
        eventType: old ? "restaurant_table.updated" : "restaurant_table.created",
        eventPayload: { tableNumber: number, operation: old ? "update" : "create" },
        mutate: entity => {
          for (const key of Object.keys(entity)) delete entity[key];
          Object.assign(entity, clone(target.data));
          entity.updatedAt = this.now();
          return entity;
        }
      });
    }

    for (const [number, old] of current) {
      if (desired.has(number) || isRetired(old)) continue;
      if (Array.isArray(old.data.o) && old.data.o.length) {
        throw Object.assign(new Error("Cannot retire a restaurant table with an open order."), {
          code: "RESTAURANT_TABLE_HAS_OPEN_ORDER", tableNumber: number
        });
      }
      const retiredAt = this.now();
      const retiredData = { ...clone(old.data), retired: true, retiredAt, updatedAt: retiredAt };
      changes.push({
        entityType: "restaurant_table",
        entityId: old.id,
        expectedVersion: old.version,
        eventType: "restaurant_table.retired",
        eventPayload: { tableNumber: number, operation: "retire" },
        mutate: entity => {
          for (const key of Object.keys(entity)) delete entity[key];
          Object.assign(entity, clone(retiredData));
          return entity;
        }
      });
    }

    if (changes.length > 19) {
      throw new RangeError("Restaurant table snapshot changes exceed the 19-table atomic transaction limit.");
    }
    if (changes.length) {
      const committedAt = this.now();
      const auditChange = {
        entityType: "audit",
        entityId: "legacy_snapshot:aurelia_lodge_v2",
        expectedVersion: snapshotRow?.version ?? 0,
        eventType: "pms.snapshot_restaurant_table_mutation",
        eventPayload: {
          tableCount: desired.size,
          changedTables: changes.map(change => change.entityId)
        },
        mutate: entity => {
          entity.sourceKey = "aurelia_lodge_v2";
          entity.snapshot = clone(snapshot);
          entity.updatedAt = committedAt;
          return entity;
        }
      };
      // Table state and the complete recovery snapshot share one transaction.
      await this.bridge.mutateEntities([...changes, auditChange]);
    }

    const active = await this.list();
    if (active.length !== desired.size) {
      throw new Error("Restaurant table repository read-back count does not match the requested snapshot.");
    }
    for (const [number, target] of desired) {
      const stored = await this.bridge.fetchEntity("restaurant_table", target.id);
      if (!stored || isRetired(stored) || !same(stored.data, target.data)) {
        throw Object.assign(new Error("Restaurant table commit failed exact read-back for table " + number + "."), {
          code: "RESTAURANT_TABLE_READBACK_FAILED", tableNumber: number
        });
      }
    }
    if (changes.length) {
      const storedSnapshot = await this.bridge.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2");
      if (!storedSnapshot || !same(storedSnapshot.data.snapshot, snapshot)) {
        throw Object.assign(new Error("Restaurant table transaction failed exact recovery snapshot read-back."), {
          code: "RESTAURANT_TABLE_SNAPSHOT_READBACK_FAILED"
        });
      }
    }
    return Object.freeze({ count: active.length, changed: changes.length, tables: active });
  }
}
