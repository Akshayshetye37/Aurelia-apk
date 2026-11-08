/**
 * Aurelia PMS local-first persistence coordinator.
 *
 * This module deliberately does not switch the legacy UI to asynchronous
 * persistence. It prepares and verifies the canonical repository first.
 * UI cutover is a separate release gate requiring every mutation path to be
 * routed through the repository.
 */
import { IndexedDbPmsRepository, parseLegacyPmsSnapshot } from "./indexeddb-pms-repository.mjs";
import { LegacyImporter, LEGACY_STATE_KEY, LEGACY_MIGRATION_STATUS_KEY } from "./legacy-importer.mjs";
import { getOrCreateBrowserLocalIdentity } from "./pms-local-identity.mjs";
import { settlePaymentToRepository } from "../payments/repository-settlement-service.mjs";
import { PmsRepositoryBridge } from "./pms-repository-bridge.mjs";
import { projectLegacyPmsDomains } from "./pms-domain-cutover.mjs";

export const AURELIA_LEGACY_STATE_KEY = LEGACY_STATE_KEY;
export const AURELIA_MIGRATION_STATUS_KEY = LEGACY_MIGRATION_STATUS_KEY;

async function createNativeRepository() {
  const { capacitorPmsStorage } = await import("./capacitor-pms-storage.mjs");
  return capacitorPmsStorage;
}

export function stableMigrationId(raw) {
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
    this.legacyImporter = new LegacyImporter(storage);
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
      // Ask the browser to protect the authoritative database from routine
      // storage-pressure eviction. A denial is surfaced, never treated as a
      // successful guarantee or as a reason to fall back to Web Storage.
      this.persistenceRequested = false;
      this.persistenceGranted = null;
      const storageManager = globalThis.navigator?.storage;
      if (typeof storageManager?.persist === "function") {
        this.persistenceRequested = true;
        try { this.persistenceGranted = await storageManager.persist(); }
        catch (error) {
          this.persistenceGranted = false;
          console.warn("[Aurelia Storage] Persistent-storage request failed; IndexedDB remains authoritative.", error);
        }
      }
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
    const supportsAuthority = typeof this.repository.getAuthority === "function" &&
      typeof this.repository.beginMigrationAuthority === "function" &&
      typeof this.repository.completeMigrationAuthority === "function" &&
      typeof this.repository.completeFreshCanonicalAuthority === "function" &&
      typeof this.repository.revertMigrationAuthority === "function";
    const priorAuthority = supportsAuthority ? await this.repository.getAuthority() : null;
    if (supportsAuthority && priorAuthority !== "canonical") {
      await this.repository.beginMigrationAuthority();
    }
    let migration;
    try {
      migration = recovery.migrationAlreadyVerified
        ? Object.freeze({
            status: recovery.freshInstallation ? "READY_CANONICAL" : "MIGRATION_VERIFIED",
            migrated: false, alreadyMigrated: true,
            recoveredFromCanonical: true, freshInstallation: Boolean(recovery.freshInstallation),
            migrationId: recovery.migrationId || null,
            entityCount: (await this.repository.listEntities("legacy")).length,
            legacyKeyPreserved: true
          })
        : await this.executeGuardedMigration();
      if (supportsAuthority && migration.status === "MIGRATION_VERIFIED" && migration.migrationId) {
        await this.repository.completeMigrationAuthority(migration.migrationId);
      } else if (supportsAuthority && migration.status === "READY_CANONICAL") {
        await this.repository.completeFreshCanonicalAuthority();
      } else if (supportsAuthority && migration.status === "READY_EMPTY" && priorAuthority !== "canonical") {
        await this.repository.revertMigrationAuthority();
      }
    } catch (error) {
      if (supportsAuthority && priorAuthority !== "canonical") {
        await this.repository.revertMigrationAuthority().catch(() => {});
      }
      throw error;
    }
    this.status = migration.status;

    // Project the verified source snapshot before releasing the UI. Projection
    // is resumable and idempotent; it does not authorize synchronous UI cutover.
    let domainProjection = null;
    if (["MIGRATION_VERIFIED", "READY_CANONICAL"].includes(migration.status) && migration.migrationId) {
      const raw = this.legacyImporter.readLegacyState();
      const source = parseLegacyPmsSnapshot(raw);
      const bridge = new PmsRepositoryBridge({
        tenantId: identity.tenantId, propertyId: identity.propertyId,
        deviceId: identity.deviceId, now: this.now
      });
      bridge.bindActiveEngine(this.repository, identity);
      domainProjection = await projectLegacyPmsDomains({
        bridge, snapshot: source.parsed, migrationId: migration.migrationId
      });
    }

    return Object.freeze({
      success: true, environment: this.environment, storageEngine: this.storageEngine,
      persistentStorage: Object.freeze({ requested: Boolean(this.persistenceRequested), granted: this.persistenceGranted }),
      uiCutover: false, recovery, migration, domainProjection,
      repository: this.repository, identity
    });
  }

  async restoreLegacyStateFromCanonical() {
    const existing = this.legacyImporter.readLegacyState();
    if (existing != null && existing !== "") {
      return Object.freeze({ restored: false, source: "legacy-store-present" });
    }

    const marker = this.legacyImporter.readMigrationStatus();
    const markerMatch = typeof marker === "string" && marker.match(/^VERIFIED:(mig_legacy_[a-f0-9]{8})$/);
    const freshMatch = typeof marker === "string" && marker.match(/^READY_CANONICAL:(mig_legacy_[a-f0-9]{8})$/);
    // A later canonical snapshot is newer than the immutable first-migration
    // snapshot. Prefer it so recovery cannot roll back valid operational saves.
    const canonical = await this.repository.getEntity("audit", "legacy_snapshot:aurelia_lodge_v2");
    const snapshot = canonical?.data?.snapshot;
    if (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)) {
      const serialized = JSON.stringify(snapshot);
      parseLegacyPmsSnapshot(serialized);
      const existingLegacy = await this.repository.listEntities("legacy");
      if (freshMatch && existingLegacy.length) throw new Error("Fresh-install marker conflicts with migrated legacy entities; startup stopped");
      if (markerMatch && !existingLegacy.length) throw new Error("Verified migration marker has no migrated legacy entities; startup stopped");
      if (!markerMatch && !freshMatch && !existingLegacy.length) {
        const freshId = stableMigrationId(serialized);
        this.legacyImporter.writeMigrationStatus("READY_CANONICAL:" + freshId);
        if (this.legacyImporter.readMigrationStatus() !== "READY_CANONICAL:" + freshId) {
          throw new Error("Fresh canonical installation marker failed exact read-back verification");
        }
        this.legacyImporter.writeLegacyState(serialized);
        if (this.legacyImporter.readLegacyState() !== serialized) {
          throw new Error("Canonical recovery rejected: restored fresh snapshot failed exact read-back verification");
        }
        return Object.freeze({
          restored: true, source: "canonical-audit-snapshot", migrationAlreadyVerified: true,
          freshInstallation: true, migrationId: freshId, version: canonical.version
        });
      }
      this.legacyImporter.writeLegacyState(serialized);
      if (this.legacyImporter.readLegacyState() !== serialized) {
        throw new Error("Canonical recovery rejected: restored latest snapshot failed exact read-back verification");
      }
      return Object.freeze({
        restored: true, source: "canonical-audit-snapshot",
        migrationAlreadyVerified: Boolean(freshMatch),
        freshInstallation: Boolean(freshMatch),
        migrationId: markerMatch?.[1] || freshMatch?.[1] || null,
        version: canonical.version, snapshotSha256: canonical.data.snapshotSha256 || null
      });
    }

    // Only fall back to the immutable migration bytes if no newer snapshot exists.
    if (markerMatch) {
      const original = await this.repository.readMigrationSnapshot(markerMatch[1]);
      if (!original?.raw || original.sourceKey !== AURELIA_LEGACY_STATE_KEY) {
        throw new Error("Verified migration marker has no matching immutable source snapshot; startup stopped");
      }
      parseLegacyPmsSnapshot(original.raw);
      this.legacyImporter.writeLegacyState(original.raw);
      if (this.legacyImporter.readLegacyState() !== original.raw) {
        throw new Error("Canonical migration recovery failed exact raw snapshot read-back verification");
      }
      return Object.freeze({
        restored: true, source: "canonical-migration-snapshot",
        migrationAlreadyVerified: false, migrationId: markerMatch[1]
      });
    }
    if (freshMatch) {
      throw new Error("Fresh canonical installation marker has no committed full-state snapshot; startup stopped");
    }

    const migrated = await this.repository.listEntities("legacy");
    if (migrated.length) {
      throw new Error("Canonical PMS records exist but no committed full-state recovery snapshot is available; startup stopped to prevent an empty-state overwrite");
    }
    return Object.freeze({ restored: false, source: "no-existing-pms-data" });
  }

  async executeGuardedMigration() {
    const rawAtStart = this.legacyImporter.readLegacyState();
    if (rawAtStart == null || rawAtStart === "") {
      return Object.freeze({ status: "READY_EMPTY", migrated: false, entityCount: 0 });
    }

    const marker = this.legacyImporter.readMigrationStatus();
    const freshMatch = typeof marker === "string" && marker.match(/^READY_CANONICAL:(mig_legacy_[a-f0-9]{8})$/);
    if (freshMatch) {
      const legacyRows = await this.repository.listEntities("legacy");
      if (legacyRows.length) throw new Error("Fresh canonical installation unexpectedly contains legacy migration rows; startup stopped");
      const latest = await this.repository.getEntity("audit", "legacy_snapshot:aurelia_lodge_v2");
      if (!latest?.data?.snapshot || typeof latest.data.snapshot !== "object" || Array.isArray(latest.data.snapshot)) {
        throw new Error("Fresh canonical installation marker has no committed recovery snapshot; startup stopped");
      }
      const canonicalRaw = JSON.stringify(latest.data.snapshot);
      parseLegacyPmsSnapshot(canonicalRaw);
      if (this.legacyImporter.readLegacyState() !== canonicalRaw) {
        this.legacyImporter.writeLegacyState(canonicalRaw);
        if (this.legacyImporter.readLegacyState() !== canonicalRaw) {
          throw new Error("Fresh canonical snapshot could not repair the compatibility cache");
        }
      }
      return Object.freeze({
        status: "READY_CANONICAL", migrated: false, alreadyMigrated: true,
        freshInstallation: true, migrationId: freshMatch[1],
        entityCount: 0, legacyKeyPreserved: true
      });
    }

    const markerMatch = typeof marker === "string" && marker.match(/^VERIFIED:(mig_legacy_[a-f0-9]{8})$/);
    if (markerMatch) {
      const migrationId = markerMatch[1];
      const original = await this.repository.readMigrationSnapshot(migrationId);
      if (!original?.raw || original.sourceKey !== AURELIA_LEGACY_STATE_KEY) {
        throw new Error("Verified migration marker has no matching immutable source snapshot; startup stopped");
      }
      const originalSnapshot = parseLegacyPmsSnapshot(original.raw);
      const rows = await this.repository.listEntities("legacy");
      const expected = Object.entries(originalSnapshot.parsed);
      if (rows.length !== expected.length) throw new Error("Verified migration source entity count no longer matches its immutable snapshot");
      const actual = new Map(rows.map(row => [row.id, row]));
      for (const [key, value] of expected) {
        const row = actual.get(key);
        if (!row || row.version !== 1 || JSON.stringify(row.data) !== JSON.stringify(value)) {
          throw new Error("Verified migration source read-back mismatch for " + key);
        }
      }
      const latest = await this.repository.getEntity("audit", "legacy_snapshot:aurelia_lodge_v2");
      if (latest?.data?.snapshot && typeof latest.data.snapshot === "object" && !Array.isArray(latest.data.snapshot)) {
        const canonicalRaw = JSON.stringify(latest.data.snapshot);
        parseLegacyPmsSnapshot(canonicalRaw);
        if (this.legacyImporter.readLegacyState() !== canonicalRaw) {
          this.legacyImporter.writeLegacyState(canonicalRaw);
          if (this.legacyImporter.readLegacyState() !== canonicalRaw) {
            throw new Error("Latest canonical PMS snapshot could not refresh the compatibility cache");
          }
        }
      } else if (rawAtStart !== original.raw) {
        throw new Error("Legacy PMS cache differs from its immutable migration source but no committed canonical snapshot exists; startup stopped");
      }
      return Object.freeze({
        status: "MIGRATION_VERIFIED", migrated: false, alreadyMigrated: true,
        migrationId, entityCount: rows.length, legacyKeyPreserved: true
      });
    }

    const existingLegacy = await this.repository.listEntities("legacy");
    if (existingLegacy.length) {
      const latest = await this.repository.getEntity("audit", "legacy_snapshot:aurelia_lodge_v2");
      if (!latest?.data?.snapshot || typeof latest.data.snapshot !== "object" || Array.isArray(latest.data.snapshot)) {
        throw new Error("Legacy migration marker is missing and no canonical recovery snapshot exists; startup stopped");
      }
      const canonicalRaw = JSON.stringify(latest.data.snapshot);
      parseLegacyPmsSnapshot(canonicalRaw);
      if (this.legacyImporter.readLegacyState() !== canonicalRaw) {
        this.legacyImporter.writeLegacyState(canonicalRaw);
        if (this.legacyImporter.readLegacyState() !== canonicalRaw) {
          throw new Error("Canonical snapshot could not repair the legacy compatibility cache");
        }
      }
      return Object.freeze({
        status: "MIGRATION_VERIFIED", migrated: false, alreadyMigrated: true,
        recoveredFromCanonical: true, migrationId: null,
        entityCount: existingLegacy.length, legacyKeyPreserved: true
      });
    }

    const existingSnapshot = await this.repository.getEntity("audit", "legacy_snapshot:aurelia_lodge_v2");
    if (existingSnapshot && (!existingSnapshot.data?.snapshot || typeof existingSnapshot.data.snapshot !== "object" || Array.isArray(existingSnapshot.data.snapshot))) {
      throw new Error("Canonical audit snapshot record exists without a valid full-state snapshot; startup stopped");
    }
    if (existingSnapshot?.data?.snapshot && typeof existingSnapshot.data.snapshot === "object" && !Array.isArray(existingSnapshot.data.snapshot)) {
      const canonicalRaw = JSON.stringify(existingSnapshot.data.snapshot);
      parseLegacyPmsSnapshot(canonicalRaw);
      if (this.legacyImporter.readLegacyState() !== canonicalRaw) {
        this.legacyImporter.writeLegacyState(canonicalRaw);
        if (this.legacyImporter.readLegacyState() !== canonicalRaw) {
          throw new Error("Fresh canonical snapshot could not repair the compatibility cache");
        }
      }
      const migrationId = stableMigrationId(canonicalRaw);
      this.legacyImporter.writeMigrationStatus("READY_CANONICAL:" + migrationId);
      if (this.legacyImporter.readMigrationStatus() !== "READY_CANONICAL:" + migrationId) {
        throw new Error("Fresh canonical installation marker failed exact read-back verification");
      }
      return Object.freeze({
        status: "READY_CANONICAL", migrated: false, alreadyMigrated: true,
        freshInstallation: true, migrationId, entityCount: 0, legacyKeyPreserved: true
      });
    }

    const snapshot = parseLegacyPmsSnapshot(rawAtStart);
    const migrationId = stableMigrationId(rawAtStart);
    const sourceKey = AURELIA_LEGACY_STATE_KEY;
    const result = await this.repository.migrateLegacySnapshot(snapshot, {
      migrationId, sourceKey, sourceTimestamp: this.now()
    });
    const storedSnapshot = await this.repository.readMigrationSnapshot(migrationId);
    if (!storedSnapshot || storedSnapshot.raw !== rawAtStart || storedSnapshot.sourceKey !== sourceKey) {
      throw new Error("Legacy migration rejected: exact raw snapshot read-back mismatch");
    }
    const rows = await this.repository.listEntities("legacy");
    const expected = Object.entries(snapshot.parsed);
    if (rows.length !== expected.length) throw new Error("Legacy migration rejected: imported entity count mismatch");
    const actual = new Map(rows.map(row => [row.id, row]));
    for (const [key, value] of expected) {
      const row = actual.get(key);
      if (!row || row.version !== 1 || JSON.stringify(row.data) !== JSON.stringify(value)) {
        throw new Error("Legacy migration rejected: read-back mismatch for " + key);
      }
    }
    this.legacyImporter.writeMigrationStatus("VERIFIED:" + migrationId);
    if (this.legacyImporter.readLegacyState() !== rawAtStart) {
      throw new Error("Legacy migration source changed during verification; startup stopped");
    }
    return Object.freeze({
      status: "MIGRATION_VERIFIED", migrated: !result.alreadyMigrated,
      alreadyMigrated: Boolean(result.alreadyMigrated), migrationId,
      entityCount: rows.length, legacyKeyPreserved: true
    });
  }
}

export const bootstrapper = new PmsBootstrapCoordinator();
