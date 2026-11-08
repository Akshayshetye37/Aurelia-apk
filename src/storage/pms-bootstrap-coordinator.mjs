/**
 * Aurelia PMS local-first persistence coordinator.
 *
 * This module deliberately does not switch the legacy UI to asynchronous
 * persistence. It prepares and verifies the canonical repository first.
 * UI cutover is a separate release gate requiring every mutation path to be
 * routed through the repository.
 */
import { IndexedDbPmsRepository, parseLegacyPmsSnapshot } from "./indexeddb-pms-repository.mjs";
import { getOrCreateBrowserLocalIdentity } from "./pms-local-identity.mjs";

export const AURELIA_LEGACY_STATE_KEY = "aurelia_lodge_v2";
export const AURELIA_MIGRATION_STATUS_KEY = "aurelia_canonical_migration_status";

async function createNativeRepository() {
  const { capacitorPmsStorage } = await import("./capacitor-pms-storage.mjs");
  return capacitorPmsStorage;
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
    now = () => new Date().toISOString(),
    identityProvider = null
  } = {}) {
    this.storage = storage;
    this.indexedDBImpl = indexedDBImpl;
    this.databaseName = databaseName;
    this.repository = repository;
    this.nativeRepositoryFactory = nativeRepositoryFactory;
    this.storageEngine = null;
    this.platform = platform;
    this.now = now;
    this.identityProvider = identityProvider;
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

    const identity = this.identityProvider
      ? await this.identityProvider({ environment: this.environment, repository: this.repository })
      : this.environment === "ANDROID_WEBVIEW"
        ? await this.repository.getOrCreateLocalIdentity()
        : await getOrCreateBrowserLocalIdentity({ indexedDBImpl: this.indexedDBImpl, storage: this.storage });
    if (!identity || identity.scope !== "LOCAL_ONLY" || !identity.installationId || !identity.tenantId || !identity.propertyId || !identity.deviceId) {
      throw new Error("Durable local PMS identity was not verified");
    }

    // If the legacy Web Storage copy was cleared or lost, recover it from the
    // last fully committed canonical snapshot before the UI is allowed to start.
    // This is a recovery bridge, not a claim that the synchronous UI has cut over.
    const recovery = await this.restoreLegacyStateFromCanonical();
    const migration = recovery.migrationAlreadyVerified
      ? Object.freeze({
          status: "MIGRATION_VERIFIED",
          migrated: false,
          alreadyMigrated: true,
          recoveredFromCanonical: true,
          entityCount: (await this.repository.listEntities("legacy")).length,
          legacyKeyPreserved: true
        })
      : await this.executeGuardedMigration();
    this.status = migration.status;
    return Object.freeze({
      success: true,
      environment: this.environment,
      storageEngine: this.storageEngine,
      uiCutover: false,
      recovery,
      migration,
      repository: this.repository,
      identity
    });
  }

  async restoreLegacyStateFromCanonical() {
    const existing = this.storage.getItem(AURELIA_LEGACY_STATE_KEY);
    if (existing != null && existing !== "") {
      return Object.freeze({ restored: false, source: "legacy-store-present" });
    }

    // Prefer the exact original migration bytes whenever the small migration
    // marker survived. This preserves the stable migration ID and byte identity.
    const marker = this.storage.getItem(AURELIA_MIGRATION_STATUS_KEY);
    const markerMatch = typeof marker === "string" && marker.match(/^VERIFIED:(mig_legacy_[a-f0-9]{8})$/);
    if (markerMatch) {
      const original = await this.repository.readMigrationSnapshot(markerMatch[1]);
      if (original?.raw) {
        parseLegacyPmsSnapshot(original.raw);
        this.storage.setItem(AURELIA_LEGACY_STATE_KEY, original.raw);
        if (this.storage.getItem(AURELIA_LEGACY_STATE_KEY) !== original.raw) {
          throw new Error("Canonical migration recovery failed exact raw snapshot read-back verification");
        }
        return Object.freeze({ restored: true, source: "canonical-migration-snapshot", migrationAlreadyVerified: false });
      }
    }

    const canonical = await this.repository.getEntity("audit", "legacy_snapshot:aurelia_lodge_v2");
    const snapshot = canonical?.data?.snapshot;
    if (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)) {
      const serialized = JSON.stringify(snapshot);
      // Validate the complete real PMS shape before writing anything back.
      parseLegacyPmsSnapshot(serialized);
      const migrated = await this.repository.listEntities("legacy");
      if (!migrated.length) {
        throw new Error("Canonical audit snapshot exists without verified migrated PMS entities; startup stopped");
      }
      this.storage.setItem(AURELIA_LEGACY_STATE_KEY, serialized);
      if (this.storage.getItem(AURELIA_LEGACY_STATE_KEY) !== serialized) {
        throw new Error("Canonical recovery rejected: restored legacy state failed exact read-back verification");
      }
      return Object.freeze({
        restored: true,
        source: "canonical-audit-snapshot",
        migrationAlreadyVerified: true,
        version: canonical.version,
        snapshotSha256: canonical.data.snapshotSha256 || null
      });
    }

    // Never silently launch an empty PMS when canonical migrated records exist.
    // The original migration snapshot remains the authoritative recovery source;
    // without a readable full snapshot, startup must stop rather than risk loss.
    const migrated = await this.repository.listEntities("legacy");
    if (migrated.length) {
      throw new Error("Canonical PMS records exist but no committed full-state recovery snapshot is available; startup stopped to prevent an empty-state overwrite");
    }
    return Object.freeze({ restored: false, source: "no-existing-pms-data" });
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
