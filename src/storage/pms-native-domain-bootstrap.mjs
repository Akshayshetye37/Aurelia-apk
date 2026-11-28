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

  return Object.freeze({
    initialized,
    identity: Object.freeze({ ...identity }),
    bridge,
    projection,
    repositories: Object.freeze({
      settings: new PmsSettingsRepository({ bridge }),
      expenses: new PmsExpenseRepository({ bridge }),
      inventory: new PmsInventoryRepository({ bridge }),
      restaurantTables: new PmsRestaurantTableRepository({ bridge }),
      restaurantSales: new PmsRestaurantSaleRepository({ bridge })
    })
  });
}
