/**
 * Read/backfill boundary for immutable restaurant sale records.
 * New settlement and hotel-folio sale writes remain owned by their atomic
 * operational mutation services; this repository backfills legacy sales and
 * verifies that compatibility snapshots never rewrite an existing sale.
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
const safeId = value => {
  const id = String(value ?? "").trim();
  if (!id || id.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) {
    throw new TypeError("Restaurant sale must have a stable safe ID.");
  }
  return id;
};
const normalizeSales = sales => {
  if (sales === undefined || sales === null) sales = [];
  if (!Array.isArray(sales)) throw new TypeError("Restaurant sales snapshot must be an array.");
  const ids = new Set();
  return sales.map((sale, index) => {
    if (!sale || typeof sale !== "object" || Array.isArray(sale)) {
      throw new TypeError("Restaurant sale snapshot contains a malformed row.");
    }
    const id = safeId(sale.id ?? ("legacy-restaurant-sale-" + (index + 1)));
    if (ids.has(id)) throw new Error("Restaurant sale IDs must be unique.");
    ids.add(id);
    return { id, data: { ...clone(sale), id } };
  });
};

export class PmsRestaurantSaleRepository {
  constructor({ bridge } = {}) {
    if (!bridge || typeof bridge.fetchEntity !== "function" ||
        typeof bridge.listEntities !== "function" || typeof bridge.mutateEntity !== "function" ||
        typeof bridge.mutateEntities !== "function") {
      throw new TypeError("A bound transactional PMS repository bridge is required.");
    }
    this.bridge = bridge;
    this.writeQueue = Promise.resolve();
  }

  async list() {
    const rows = await this.bridge.listEntities("restaurant_sale");
    if (!Array.isArray(rows)) throw new Error("Canonical restaurant sale repository returned an invalid entity list.");
    const ids = new Set();
    const sales = [];
    for (const row of rows) {
      if (!row || row.type !== "restaurant_sale" || typeof row.id !== "string" ||
          !Number.isSafeInteger(row.version) || row.version < 1 ||
          !row.data || typeof row.data !== "object" || Array.isArray(row.data)) {
        throw new Error("Canonical restaurant sale inventory contains an invalid entity.");
      }
      const id = safeId(row.id);
      if (ids.has(id) || safeId(row.data.id) !== id) {
        throw new Error("Canonical restaurant sale inventory contains a duplicate or unstable sale identity.");
      }
      ids.add(id);
      sales.push(clean(row.data));
    }
    return sales.sort((a, b) =>
      String(a.at || a.paidAt || a.createdAt || "").localeCompare(String(b.at || b.paidAt || b.createdAt || "")) ||
      String(a.id).localeCompare(String(b.id))
    );
  }

  async hydrateSnapshot(snapshot, { enabled = true } = {}) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      throw new TypeError("A PMS snapshot is required for restaurant sale hydration.");
    }
    const hydrated = clone(snapshot);
    const source = normalizeSales(hydrated.sales);
    if (!enabled) {
      hydrated.sales = source.map(row => row.data);
      return hydrated;
    }
    const canonical = await this.list();
    const byId = new Map(canonical.map(row => [row.id, row]));
    const used = new Set();
    const result = [];
    for (const row of source) {
      const stored = byId.get(row.id);
      if (!stored) {
        throw Object.assign(new Error("Canonical restaurant sale " + row.id + " is missing; recovery is required."), {
          code: "RESTAURANT_SALE_ENTITY_MISSING", saleId: row.id
        });
      }
      used.add(row.id);
      result.push(clone(stored));
    }
    // Include a sale committed before the compatibility snapshot refresh.
    for (const row of canonical) if (!used.has(row.id)) result.push(clone(row));
    hydrated.sales = result;
    return hydrated;
  }

  syncSnapshot(snapshot) {
    const operation = () => this.#syncSnapshot(snapshot);
    const pending = this.writeQueue.then(operation, operation);
    this.writeQueue = pending.catch(() => {});
    return pending;
  }

  async #syncSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      throw new TypeError("A PMS snapshot is required for restaurant sale synchronization.");
    }
    const normalized = normalizeSales(snapshot.sales);
    const currentRows = await this.bridge.listEntities("restaurant_sale");
    if (!Array.isArray(currentRows)) throw new Error("Canonical restaurant sale repository returned an invalid entity list.");
    const current = new Map();
    for (const row of currentRows) {
      if (!row || row.type !== "restaurant_sale" || typeof row.id !== "string" ||
          !Number.isSafeInteger(row.version) || row.version < 1 ||
          !row.data || typeof row.data !== "object" || Array.isArray(row.data)) {
        throw new Error("Canonical restaurant sale inventory contains an invalid entity.");
      }
      const id = safeId(row.id);
      if (safeId(row.data.id) !== id || current.has(id)) {
        throw new Error("Canonical restaurant sale inventory contains a duplicate or unstable sale identity.");
      }
      current.set(id, row);
    }

    const changes = [];
    for (const sale of normalized) {
      const old = current.get(sale.id);
      if (old) {
        if (!same(old.data, sale.data)) {
          throw Object.assign(new Error("Restaurant sale " + sale.id + " is immutable and differs from canonical storage."), {
            code: "RESTAURANT_SALE_IMMUTABLE_DIVERGENCE", saleId: sale.id
          });
        }
        continue;
      }
      changes.push({
        entityType: "restaurant_sale",
        entityId: sale.id,
        expectedVersion: 0,
        eventType: "restaurant_sale.created",
        eventPayload: {
          saleId: sale.id,
          tableId: sale.data.t == null ? null : String(sale.data.t),
          operation: "legacy_or_snapshot_backfill"
        },
        mutate: entity => {
          for (const key of Object.keys(entity)) delete entity[key];
          Object.assign(entity, clone(sale.data));
          return entity;
        }
      });
    }

    if (changes.length > 20) {
      throw new RangeError("Restaurant sale snapshot changes exceed the 20-entity atomic transaction limit.");
    }
    if (changes.length === 1) await this.bridge.mutateEntity(changes[0]);
    else if (changes.length > 1) await this.bridge.mutateEntities(changes);

    const storedSales = await this.list();
    const storedById = new Map(storedSales.map(row => [row.id, row]));
    for (const sale of normalized) {
      const stored = storedById.get(sale.id);
      if (!stored || !same(stored, sale.data)) {
        throw Object.assign(new Error("Restaurant sale commit failed exact read-back for " + sale.id + "."), {
          code: "RESTAURANT_SALE_READBACK_FAILED", saleId: sale.id
        });
      }
    }
    return Object.freeze({
      count: storedSales.length,
      created: changes.length,
      sales: storedSales
    });
  }
}
