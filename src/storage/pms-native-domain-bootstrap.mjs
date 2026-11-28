import { CapacitorPmsStorageClient } from "./capacitor-pms-storage.mjs";
import { PmsRepositoryBridge } from "./pms-repository-bridge.mjs";
import { projectLegacyPmsDomains } from "./pms-domain-cutover.mjs";
import { PmsSettingsRepository } from "./pms-settings-repository.mjs";
import { PmsExpenseRepository } from "./pms-expense-repository.mjs";
import { PmsInventoryRepository } from "./pms-inventory-repository.mjs";
import { PmsRestaurantTableRepository } from "./pms-restaurant-table-repository.mjs";
import { PmsRestaurantSaleRepository } from "./pms-restaurant-sale-repository.mjs";

const clone = value => value == null ? value :
  (typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value)));

const requireArray = (value, label) => {
  if (!Array.isArray(value)) throw new TypeError("PMS " + label + " must be an array before domain projection.");
  return value;
};

export function toLegacyDomainSnapshot(state) {
  if (!state || typeof state !== "object" || Array.isArray(state) ||
      !state.settings || typeof state.settings !== "object" || Array.isArray(state.settings) ||
      !state.menu || typeof state.menu !== "object" || Array.isArray(state.menu)) {
    throw new TypeError("A normalized PMS workspace is required for domain projection.");
  }
  const financialLedger = Array.isArray(state.financialLedger) ? state.financialLedger : [];
  const inventoryLedger = Array.isArray(state.legacyInventoryLedger) ? state.legacyInventoryLedger : [];
  const ledger = [
    ...financialLedger.map((value, index) => ({ sourceCollection: "financialLedger", sourceIndex: index, value: clone(value) })),
    ...inventoryLedger.map((value, index) => ({ sourceCollection: "legacyInventoryLedger", sourceIndex: index, value: clone(value) }))
  ];
  return {
    rooms: clone(requireArray(state.rooms, "rooms")),
    b: clone(requireArray(state.bookings, "bookings")),
    g: clone(requireArray(state.guests, "guests")),
    t: clone(requireArray(state.tables, "tables")),
    sales: clone(requireArray(state.sales, "sales")),
    inv: clone(requireArray(state.inventory, "inventory")),
    exp: clone(requireArray(state.expenses, "expenses")),
    led: ledger,
    aud: clone(requireArray(state.audit, "audit")),
    set: clone(state.settings),
    menu: clone(state.menu)
  };
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  try {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  } finally { bytes.fill(0); }
}

function stable(value) {
  return Array.isArray(value) ? value.map(stable) :
    value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
      : value;
}
const same = (left, right) => JSON.stringify(stable(left)) === JSON.stringify(stable(right));

async function syncEntityRows(bridge, entityType, rows, { idFor, dataFor, immutable = false } = {}) {
  if (!Array.isArray(rows)) throw new TypeError("PMS " + entityType + " rows must be an array.");
  const currentRows = await bridge.listEntities(entityType);
  const current = new Map();
  for (const row of currentRows) {
    if (!row || row.type !== entityType || typeof row.id !== "string" ||
        !Number.isSafeInteger(row.version) || row.version < 1 || !row.data ||
        typeof row.data !== "object" || Array.isArray(row.data) || current.has(row.id)) {
      throw new Error("Canonical " + entityType + " repository contains an invalid or duplicate entity.");
    }
    current.set(row.id, row);
  }
  const desired = new Set();
  const changes = [];
  rows.forEach((row, index) => {
    const id = String(idFor(row, index));
    if (!id || id.length > 180 || /[\u0000-\u001f]/.test(id) || desired.has(id)) {
      throw new Error("PMS " + entityType + " collection contains an invalid or duplicate stable identity.");
    }
    desired.add(id);
    const data = dataFor(row, index, id);
    const old = current.get(id);
    if (old && same(old.data, data)) return;
    if (old && immutable) {
      throw Object.assign(new Error("Immutable PMS " + entityType + " entity " + id + " differs from its canonical record."), {
        code: "PMS_IMMUTABLE_ENTITY_DIVERGENCE", entityType, entityId: id
      });
    }
    changes.push({
      entityType, entityId: id, expectedVersion: old?.version ?? 0,
      eventType: old ? entityType + ".updated" : entityType + ".created",
      eventPayload: { entityType, entityId: id, source: "workspace_compatibility_projection" },
      mutate: entity => {
        for (const key of Object.keys(entity)) delete entity[key];
        Object.assign(entity, clone(data));
        return entity;
      }
    });
  });
  for (let offset = 0; offset < changes.length; offset += 20) {
    const batch = changes.slice(offset, offset + 20);
    if (batch.length === 1) await bridge.mutateEntity(batch[0]);
    else await bridge.mutateEntities(batch);
  }
  return Object.freeze({ checked: rows.length, changed: changes.length });
}

function folioSource(row, index, currency) {
  const bookingId = String(row.id);
  const id = String(row.folioId ?? "booking-" + bookingId);
  return {
    id,
    bookingId,
    legacyPaidTotal: row.p ?? null,
    legacyPaymentRows: clone(Array.isArray(row.pays) ? row.pays : []),
    legacyPaymentHistory: clone(Array.isArray(row.payments) ? row.payments : []),
    legacyCurrencySymbol: currency
  };
}

export async function bootstrapNativePmsDomains({ plugin, state } = {}) {
  if (!plugin) throw new TypeError("The registered Capacitor PMS SQLCipher plugin is required.");
  const snapshot = toLegacyDomainSnapshot(state);
  const storage = new CapacitorPmsStorageClient(plugin);
  const initialized = await storage.initializeStorage();
  const identity = await storage.getOrCreateLocalIdentity();
  for (const key of ["tenantId", "propertyId", "deviceId"]) {
    if (typeof identity?.[key] !== "string" || !identity[key]) throw new Error("Native PMS identity is missing " + key + ".");
  }
  const bridge = new PmsRepositoryBridge({
    tenantId: identity.tenantId,
    propertyId: identity.propertyId,
    deviceId: identity.deviceId
  }).bindActiveEngine(storage, identity);

  const migrationSeed = identity.tenantId + "|" + identity.propertyId + "|" + identity.deviceId + "|domain-projection-v1";
  const migrationId = "native-domain-v1-" + (await sha256Hex(migrationSeed)).slice(0, 48);
  const sourceId = "domain-projection-source:" + migrationId;
  const manifestId = "legacy-domain-projection:" + migrationId;
  let source = await bridge.fetchEntity("audit", sourceId);
  if (!source) {
    const existingManifest = await bridge.fetchEntity("audit", manifestId);
    if (existingManifest) throw new Error("PMS domain projection manifest exists without its immutable source snapshot; manual recovery is required.");
    const sourceSnapshot = clone(snapshot);
    const sourceSha256 = await sha256Hex(sourceSnapshot);
    await bridge.mutateEntity({
      entityType: "audit",
      entityId: sourceId,
      expectedVersion: 0,
      eventType: "pms.domain_projection_source.created",
      eventPayload: { migrationId, sourceSha256 },
      mutate: entity => {
        entity.migrationId = migrationId;
        entity.sourceSha256 = sourceSha256;
        entity.snapshot = sourceSnapshot;
        entity.schemaVersion = 1;
        return entity;
      }
    });
    source = await bridge.fetchEntity("audit", sourceId);
    if (!source || source.version !== 1 || source.data?.migrationId !== migrationId ||
        source.data?.sourceSha256 !== sourceSha256 ||
        await sha256Hex(source.data.snapshot) !== sourceSha256) {
      throw new Error("Immutable PMS domain projection source failed exact read-back verification.");
    }
  } else {
    const sourceData = source.data;
    if (source.version < 1 || sourceData?.migrationId !== migrationId ||
        sourceData?.schemaVersion !== 1 || !sourceData.snapshot ||
        typeof sourceData.sourceSha256 !== "string" ||
        await sha256Hex(sourceData.snapshot) !== sourceData.sourceSha256) {
      throw new Error("Stored PMS domain projection source is invalid; projection is frozen for recovery.");
    }
  }

  const projection = await projectLegacyPmsDomains({
    bridge,
    snapshot: source.data.snapshot,
    migrationId,
    batchSize: 20
  });

  const recoverySnapshotId = "legacy_snapshot:aurelia_lodge_v2";
  let recoverySnapshot = await bridge.fetchEntity("audit", recoverySnapshotId);
  if (!recoverySnapshot) {
    await bridge.mutateEntity({
      entityType: "audit",
      entityId: recoverySnapshotId,
      expectedVersion: 0,
      eventType: "pms.compatibility_snapshot.initialized",
      eventPayload: { migrationId, sourceSha256: source.data.sourceSha256 },
      mutate: entity => {
        entity.sourceKey = "aurelia_lodge_v2";
        entity.schemaVersion = 2;
        entity.snapshot = clone(source.data.snapshot);
        return entity;
      }
    });
    recoverySnapshot = await bridge.fetchEntity("audit", recoverySnapshotId);
  }
  if (!recoverySnapshot || recoverySnapshot.version < 1 ||
      recoverySnapshot.data?.sourceKey !== "aurelia_lodge_v2" ||
      !recoverySnapshot.data.snapshot ||
      !Array.isArray(recoverySnapshot.data.snapshot.inv) ||
      !Array.isArray(recoverySnapshot.data.snapshot.t) ||
      !Array.isArray(recoverySnapshot.data.snapshot.led) ||
      !Array.isArray(recoverySnapshot.data.snapshot.aud)) {
    throw new Error("Canonical PMS compatibility recovery snapshot is missing or malformed.");
  }

  const repositories = Object.freeze({
    settings: new PmsSettingsRepository({ bridge }),
    expenses: new PmsExpenseRepository({ bridge }),
    inventory: new PmsInventoryRepository({ bridge }),
    restaurantTables: new PmsRestaurantTableRepository({ bridge }),
    restaurantSales: new PmsRestaurantSaleRepository({ bridge })
  });

  async function syncSnapshot(nextState) {
    const next = toLegacyDomainSnapshot(nextState);
    const currency = String(next.set.cur ?? "₹");
    const summary = {};
    summary.rooms = await syncEntityRows(bridge, "room", next.rooms, {
      idFor: row => row.id ?? row.n,
      dataFor: (row, index, id) => ({ ...clone(row), id })
    });
    summary.guests = await syncEntityRows(bridge, "guest", next.g, {
      idFor: (row, index) => row.id ?? "legacy-guest-" + index,
      dataFor: (row, index, id) => ({ ...clone(row), id })
    });
    summary.bookings = await syncEntityRows(bridge, "booking", next.b, {
      idFor: row => row.id,
      dataFor: (row, index, id) => ({ ...clone(row), id })
    });
    summary.folios = await syncEntityRows(bridge, "folio", next.b, {
      idFor: row => row.folioId ?? "booking-" + row.id,
      dataFor: (row, index) => folioSource(row, index, currency)
    });
    summary.expenses = await syncEntityRows(bridge, "expense", next.exp, {
      idFor: (row, index) => row.id ?? "legacy-expense-" + index,
      dataFor: (row, index, id) => ({ ...clone(row), id })
    });
    summary.ledger = await syncEntityRows(bridge, "ledger", next.led, {
      idFor: (row, index) => "legacy-ledger-" + index,
      dataFor: (row, index) => ({ sourceCollection: "led", sourceIndex: index, value: clone(row) }),
      immutable: true
    });
    summary.audit = await syncEntityRows(bridge, "audit", next.aud, {
      idFor: (row, index) => "legacy-audit-" + index,
      dataFor: (row, index) => ({ sourceCollection: "aud", sourceIndex: index, value: clone(row) }),
      immutable: true
    });
    await repositories.settings.syncSnapshot(next);
    await repositories.inventory.syncSnapshot(next);
    await repositories.restaurantTables.syncSnapshot(next);
    await repositories.restaurantSales.syncSnapshot(next);
    const currentSnapshot = await bridge.fetchEntity("audit", recoverySnapshotId);
    if (!currentSnapshot) throw new Error("Canonical PMS recovery snapshot disappeared during domain synchronization.");
    if (!same(currentSnapshot.data.snapshot, next)) {
      await bridge.mutateEntity({
        entityType: "audit",
        entityId: recoverySnapshotId,
        expectedVersion: currentSnapshot.version,
        eventType: "pms.compatibility_snapshot.synchronized",
        eventPayload: { source: "workspace_save" },
        mutate: entity => {
          entity.sourceKey = "aurelia_lodge_v2";
          entity.schemaVersion = 2;
          entity.snapshot = clone(next);
          entity.updatedAt = new Date().toISOString();
          return entity;
        }
      });
      const verifiedSnapshot = await bridge.fetchEntity("audit", recoverySnapshotId);
      if (!verifiedSnapshot || !same(verifiedSnapshot.data.snapshot, next)) {
        throw new Error("PMS compatibility recovery snapshot failed exact read-back verification.");
      }
    }
    return Object.freeze(summary);
  }

  const sync = await syncSnapshot(state);
  return Object.freeze({
    initialized,
    identity: Object.freeze({ ...identity }),
    bridge,
    projection,
    sync,
    syncSnapshot,
    repositories
  });
}
