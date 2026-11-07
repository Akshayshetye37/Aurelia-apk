/**
 * Aurelia PMS local-first persistence coordinator.
 *
 * This module deliberately does not switch the legacy UI to asynchronous
 * persistence. It prepares and verifies the canonical repository first.
 * UI cutover is a separate release gate requiring every mutation path to be
 * routed through the repository.
 */
import { IndexedDbPmsRepository, parseLegacyPmsSnapshot } from "./indexeddb-pms-repository.mjs";

export const AURELIA_LEGACY_STATE_KEY = "aurelia_lodge_v2";
export const AURELIA_MIGRATION_STATUS_KEY = "aurelia_canonical_migration_status";

async function createNativeRepository() {
  const { CapacitorPmsStorageClient } = await import("./capacitor-pms-storage.mjs");
  return new CapacitorPmsStorageClient();
}

function stableMigrationId(raw) {
  // Stable non-cryptographic identifier: migration replay protection is
  // enforced by the repository marker and exact raw snapshot comparison.
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return "mig_legacy_" + (hash >>> 0).toString(16).padStart(8, "0");
}

function assertStorage(storage) {
  if (!storage || storage.memoryOnly === true ||
      typeof storage.getItem !== "function" ||
      typeof storage.setItem !== "function") {
    throw new TypeError("A durable Storage-compatible legacy store is required");
  }
}

export class PmsBootstrapCoordinator {
  constructor({
    storage = globalThis.window?.__aureliaStorage || globalThis.localStorage,
    indexedDBImpl = globalThis.indexedDB,
    databaseName = "aurelia-pms-canonical",
    repository = null,
    nativeRepositoryFactory = createNativeRepository,
    platform = null,
    now = () => new Date().toISOString()
  } = {}) {
    this.storage = storage;
    this.indexedDBImpl = indexedDBImpl;
    this.databaseName = databaseName;
    this.repository = repository;
    this.nativeRepositoryFactory = nativeRepositoryFactory;
    this.storageEngine = null;
    this.platform = platform;
    this.now = now;
    this.environment = "UNINITIALIZED";
    this.status = "NOT_STARTED";
    this.initialization = null;
  }

  detectEnvironment() {
    if (this.platform) return this.platform;
    const capacitor = globalThis.Capacitor;
    if (capacitor && typeof capacitor.isNativePlatform === "function" &&
        capacitor.isNativePlatform()) return "ANDROID_WEBVIEW";
    return "BROWSER_OR_PWA";
  }

  async initializeApplication() {
    if (this.initialization) return this.initialization;
    this.initialization = this.#initialize().catch(error => {
      this.status = "FAILED_CLOSED";
      this.initialization = null;
      throw error;
    });
    return this.initialization;
  }

  async #initialize() {
    assertStorage(this.storage);
    this.environment = this.detectEnvironment();

    if (!this.repository) {
      if (this.environment === "ANDROID_WEBVIEW") {
        this.repository = await this.nativeRepositoryFactory();
      } else {
        this.repository = new IndexedDbPmsRepository({
          indexedDBImpl: this.indexedDBImpl,
          databaseName: this.databaseName
        });
      }
    }

    // Android must use the registered SQLite plugin; silently substituting
    // WebView IndexedDB would recreate the dual-state architecture we are
    // removing. Browser/PWA remains on IndexedDB.
    if (this.environment === "ANDROID_WEBVIEW") {
      if (typeof this.repository.initializeStorage !== "function") {
        throw new Error("Android SQLite repository does not expose initializeStorage");
      }
      await this.repository.initializeStorage();
      this.storageEngine = "ANDROID_SQLITE";
    } else {
      if (typeof this.repository.database !== "function") {
        throw new Error("Browser repository does not expose IndexedDB initialization");
      }
      await this.repository.database();
      this.storageEngine = "INDEXEDDB";
    }
    this.status = "ENGINE_READY";

    const migration = await this.executeGuardedMigration();
    this.status = migration.status;
    return Object.freeze({
      success: true,
      environment: this.environment,
      storageEngine: this.storageEngine,
      uiCutover: false,
      migration,
      repository: this.repository
    });
  }

  async executeGuardedMigration() {
    const raw = this.storage.getItem(AURELIA_LEGACY_STATE_KEY);
    if (raw == null || raw === "") {
      return Object.freeze({ status: "READY_EMPTY", migrated: false, entityCount: 0 });
    }

    // Parse and validate before opening a write transaction. The parser checks
    // the real Aurelia v2 state shape (rooms, b, g, t, exp, inv, led, aud,
    // set and menu), rather than an invented bookings/folios JSON shape.
    const snapshot = parseLegacyPmsSnapshot(raw);
    const migrationId = stableMigrationId(raw);
    const sourceKey = AURELIA_LEGACY_STATE_KEY;

    const result = await this.repository.migrateLegacySnapshot(snapshot, {
      migrationId,
      sourceKey,
      sourceTimestamp: this.now()
    });

    // Verify the exact backup and every imported legacy collection. A count
    // match alone is insufficient to authorize migration completion.
    const storedSnapshot = await this.repository.readMigrationSnapshot(migrationId);
    if (!storedSnapshot || storedSnapshot.raw !== raw ||
        storedSnapshot.sourceKey !== sourceKey) {
      throw new Error("Legacy migration rejected: exact raw snapshot read-back mismatch");
    }

    const rows = await this.repository.listEntities("legacy");
    const expected = Object.entries(snapshot.parsed);
    if (rows.length !== expected.length) {
      throw new Error("Legacy migration rejected: imported entity count mismatch");
    }
    const actual = new Map(rows.map(row => [row.id, row]));
    for (const [key, value] of expected) {
      const row = actual.get(key);
      if (!row || row.version !== 1 ||
          JSON.stringify(row.data) !== JSON.stringify(value)) {
        throw new Error("Legacy migration rejected: read-back mismatch for " + key);
      }
    }

    // Marker is only a diagnostic hint. Repository metadata and exact snapshot
    // verification remain authoritative; the original legacy value is untouched.
    this.storage.setItem(AURELIA_MIGRATION_STATUS_KEY, "VERIFIED:" + migrationId);
    return Object.freeze({
      status: "MIGRATION_VERIFIED",
      migrated: !result.alreadyMigrated,
      alreadyMigrated: Boolean(result.alreadyMigrated),
      migrationId,
      entityCount: rows.length,
      legacyKeyPreserved: this.storage.getItem(sourceKey) === raw
    });
  }
}

export const bootstrapper = new PmsBootstrapCoordinator();
