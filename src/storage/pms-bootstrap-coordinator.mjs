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
import { settlePaymentToRepository } from "../payments/repository-settlement-service.mjs";
import { PmsRepositoryBridge } from "./pms-repository-bridge.mjs";
import { PMS_LEGACY_SNAPSHOT_ENTITY_ID } from "./pms-repository-contract.mjs";
import { projectLegacyPmsDomains } from "./pms-domain-cutover.mjs";
import { PmsSettingsRepository } from "./pms-settings-repository.mjs";
import { PmsRestaurantTableRepository } from "./pms-restaurant-table-repository.mjs";
import { PmsRestaurantSaleRepository } from "./pms-restaurant-sale-repository.mjs";
import { PmsInventoryRepository } from "./pms-inventory-repository.mjs";
import { PmsExpenseRepository } from "./pms-expense-repository.mjs";
import { assertCompatibilityUiAllowed, ensureCanonicalPrepared } from "./pms-authority-state.mjs";

export const AURELIA_LEGACY_STATE_KEY = "aurelia_lodge_v2";
export const AURELIA_MIGRATION_STATUS_KEY = "aurelia_canonical_migration_status";

async function createNativeRepository() {
  const { capacitorPmsStorage } = await import("./capacitor-pms-storage.mjs");
  return capacitorPmsStorage;
}

export async function stableMigrationId(raw) {
  if (typeof raw !== "string") throw new TypeError("A raw legacy snapshot string is required");
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== "function") {
    throw new Error("SHA-256 is unavailable; refusing to create a weak migration identity");
  }
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(raw));
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return "mig_legacy_" + hex;
}

function assertStorage(storage) {
  if (!storage || storage.memoryOnly === true ||
      typeof storage.getItem !== "function" ||
      typeof storage.setItem !== "function" ||
      typeof storage.removeItem !== "function") {
    throw new TypeError("A durable legacy migration store with verified removal is required");
  }
}

const PROJECTION_SOURCE_PREFIX = "pms-domain-projection-source:";
async function loadOrCreateProjectionSourceSnapshot(bridge, migrationId, currentSnapshot) {
  const entityId = PROJECTION_SOURCE_PREFIX + migrationId;
  const existing = await bridge.fetchEntity("audit", entityId);
  if (existing) {
    if (existing.data?.migrationId !== migrationId || !existing.data?.snapshot ||
        typeof existing.data.snapshot !== "object" || Array.isArray(existing.data.snapshot)) {
      throw new Error("Immutable PMS domain projection source is invalid; startup stopped");
    }
    return parseLegacyPmsSnapshot(JSON.stringify(existing.data.snapshot)).parsed;
  }
  await bridge.mutateEntity({
    entityType: "audit", entityId, expectedVersion: 0,
    eventType: "pms.domain_projection_source.created",
    mutate: data => {
      data.migrationId = migrationId;
      data.sourceKey = "canonical-initial-snapshot";
      data.snapshot = currentSnapshot;
      return data;
    }
  });
  const saved = await bridge.fetchEntity("audit", entityId);
  if (!saved?.data?.snapshot || saved.data.migrationId !== migrationId ||
      JSON.stringify(saved.data.snapshot) !== JSON.stringify(currentSnapshot)) {
    throw new Error("Immutable PMS domain projection source failed exact read-back verification");
  }
  return parseLegacyPmsSnapshot(JSON.stringify(saved.data.snapshot)).parsed;
}

export class PmsBootstrapCoordinator {
  constructor({
    storage = null,
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
      if (this.environment === "ANDROID_WEBVIEW") this.repository = await this.nativeRepositoryFactory();
      else this.repository = new IndexedDbPmsRepository({ indexedDBImpl: this.indexedDBImpl, databaseName: this.databaseName });
    }
    if (this.environment === "ANDROID_WEBVIEW") {
      if (typeof this.repository.initializeStorage !== "function") throw new Error("Android SQLite repository does not expose initializeStorage");
      await this.repository.initializeStorage();
      this.storageEngine = "ANDROID_SQLITE";
    } else {
      if (typeof this.repository.database !== "function") throw new Error("Browser repository does not expose IndexedDB initialization");
      await this.repository.database();
      this.persistenceRequested = false;this.persistenceGranted = null;
      const storageManager = globalThis.navigator?.storage;
      if (typeof storageManager?.persist === "function") {
        this.persistenceRequested = true;
        try { this.persistenceGranted = await storageManager.persist(); }
        catch (error) { this.persistenceGranted = false;console.warn("[Aurelia Storage] Persistent-storage request failed; IndexedDB remains authoritative.", error); }
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
    const bridge = new PmsRepositoryBridge({tenantId:identity.tenantId,propertyId:identity.propertyId,deviceId:identity.deviceId,now:this.now});
    bridge.bindActiveEngine(this.repository, identity);this.bridge=bridge;
    await assertCompatibilityUiAllowed(bridge);
    const settingsRepository=new PmsSettingsRepository({bridge});
    const restaurantTableRepository=new PmsRestaurantTableRepository({bridge,now:this.now});
    const restaurantSaleRepository=new PmsRestaurantSaleRepository({bridge});
    const inventoryRepository=new PmsInventoryRepository({bridge,now:this.now});
    const expenseRepository=new PmsExpenseRepository({bridge});

    // A legacy browser snapshot is accepted only as a one-time migration source.
    // Once a canonical snapshot has been verified in IndexedDB/SQLCipher, the
    // plaintext Web Storage copy is purged and is never recreated.
    const recovery=await this.restoreLegacyStateFromCanonical();
    const migration=recovery.migrationAlreadyVerified
      ? Object.freeze({status:recovery.freshInstallation?"READY_CANONICAL":"MIGRATION_VERIFIED",migrated:false,alreadyMigrated:true,recoveredFromCanonical:true,freshInstallation:Boolean(recovery.freshInstallation),migrationId:recovery.migrationId||null,entityCount:(await this.repository.listEntities("legacy")).length,legacyKeyPreserved:false})
      : await this.executeGuardedMigration();
    this.status=migration.status;
    const runtimeSnapshot=recovery.snapshot||migration.snapshot||null;
    let projectionSnapshot=recovery.migrationSnapshot||migration.migrationSnapshot||null;
    if(!projectionSnapshot&&runtimeSnapshot&&migration.migrationId){
      projectionSnapshot=await loadOrCreateProjectionSourceSnapshot(bridge,migration.migrationId,runtimeSnapshot);
    }
    let domainProjection=null;
    if(["MIGRATION_VERIFIED","READY_CANONICAL"].includes(migration.status)&&migration.migrationId&&projectionSnapshot){
      domainProjection=await projectLegacyPmsDomains({bridge,snapshot:projectionSnapshot,migrationId:migration.migrationId});
    }
    const authority=await ensureCanonicalPrepared({
      bridge,migrationId:migration.migrationId||null,
      projectionStatus:domainProjection?.manifest?.status==="VERIFIED"?"VERIFIED":(domainProjection?"PENDING":"NOT_REQUIRED"),
      now:this.now
    });
    if(runtimeSnapshot){
      let canonical=await bridge.fetchEntity("audit",PMS_LEGACY_SNAPSHOT_ENTITY_ID);
      if(!canonical){
        await bridge.persistCompatibilitySnapshot(runtimeSnapshot);
        canonical=await bridge.fetchEntity("audit",PMS_LEGACY_SNAPSHOT_ENTITY_ID);
      }
      if(!canonical?.data?.snapshot||JSON.stringify(canonical.data.snapshot)!==JSON.stringify(runtimeSnapshot)){
        throw new Error("Canonical PMS snapshot failed exact repository read-back; legacy source will not be deleted");
      }
      parseLegacyPmsSnapshot(JSON.stringify(canonical.data.snapshot));
      if(this.storage.getItem(AURELIA_LEGACY_STATE_KEY)!=null){
        this.storage.removeItem(AURELIA_LEGACY_STATE_KEY);
        if(this.storage.getItem(AURELIA_LEGACY_STATE_KEY)!=null)throw new Error("Plaintext legacy PMS snapshot could not be purged after canonical verification");
      }
    }
    const {snapshot:recoverySnapshot,migrationSnapshot:recoveryMigrationSnapshot,...recoverySummary}=recovery;
    const {snapshot:migrationSnapshot,migrationSnapshot:sourceMigrationSnapshot,...migrationSummary}=migration;
    const finalMigration=Object.freeze({...migrationSummary,legacyKeyPreserved:this.storage.getItem(AURELIA_LEGACY_STATE_KEY)!=null});
    return Object.freeze({
      success:true,environment:this.environment,storageEngine:this.storageEngine,
      persistenceDurability:this.storageEngine==="ANDROID_SQLITE"?"SQLCIPHER":(this.repository.durabilityMode||"unknown"),
      persistentStorage:Object.freeze({requested:Boolean(this.persistenceRequested),granted:this.persistenceGranted}),
      uiCutover:false,authority,recovery:recoverySummary,migration:finalMigration,domainProjection,
      repository:this.repository,identity,bridge,settingsRepository,restaurantTableRepository,restaurantSaleRepository,inventoryRepository,expenseRepository
    });
  }


  async restoreLegacyStateFromCanonical() {
    await assertCompatibilityUiAllowed(this.bridge);
    const existing=this.storage.getItem(AURELIA_LEGACY_STATE_KEY);
    if(existing!=null&&existing!=="")return Object.freeze({restored:false,source:"legacy-store-present"});
    const marker=this.storage.getItem(AURELIA_MIGRATION_STATUS_KEY);
    const markerMatch=typeof marker==="string"&&marker.match(/^VERIFIED:(mig_legacy_(?:[a-f0-9]{8}|[a-f0-9]{64}))$/);
    const freshMatch=typeof marker==="string"&&marker.match(/^READY_CANONICAL:(mig_legacy_(?:[a-f0-9]{8}|[a-f0-9]{64}))$/);
    const canonical=await this.repository.getEntity("audit",PMS_LEGACY_SNAPSHOT_ENTITY_ID);
    const snapshot=canonical?.data?.snapshot;
    if(snapshot&&typeof snapshot==="object"&&!Array.isArray(snapshot)){
      const serialized=JSON.stringify(snapshot);const parsed=parseLegacyPmsSnapshot(serialized);
      const legacyRows=await this.repository.listEntities("legacy");
      let immutableMigrationSnapshot=null;
      if(freshMatch&&legacyRows.length)throw new Error("Fresh-install marker conflicts with migrated legacy entities; startup stopped");
      if(markerMatch){
        if(!legacyRows.length)throw new Error("Verified migration marker has no migrated legacy entities; startup stopped");
        const original=await this.repository.readMigrationSnapshot(markerMatch[1]);
        if(!original?.raw||original.sourceKey!==AURELIA_LEGACY_STATE_KEY)throw new Error("Verified migration marker has no matching immutable source snapshot; startup stopped");
        const source=parseLegacyPmsSnapshot(original.raw),expected=Object.entries(source.parsed);
        if(legacyRows.length!==expected.length)throw new Error("Verified migration source entity count no longer matches its immutable snapshot");
        const rows=new Map(legacyRows.map(row=>[row.id,row]));
        for(const [key,value] of expected){const row=rows.get(key);if(!row||row.version!==1||JSON.stringify(row.data)!==JSON.stringify(value))throw new Error("Verified migration source read-back mismatch for "+key)}
        immutableMigrationSnapshot=source.parsed;
      }else if(!freshMatch&&legacyRows.length){
        throw new Error("Canonical legacy rows exist without a verified migration marker; startup stopped");
      }
      let migrationId=markerMatch?.[1]||freshMatch?.[1]||null;
      let freshInstallation=Boolean(freshMatch);
      if(!migrationId){
        migrationId=await stableMigrationId(serialized);freshInstallation=true;
        this.storage.setItem(AURELIA_MIGRATION_STATUS_KEY,"READY_CANONICAL:"+migrationId);
        if(this.storage.getItem(AURELIA_MIGRATION_STATUS_KEY)!=="READY_CANONICAL:"+migrationId)throw new Error("Fresh canonical installation marker failed exact read-back verification");
      }
      return Object.freeze({restored:true,source:"canonical-audit-snapshot",migrationAlreadyVerified:true,freshInstallation,migrationId,version:canonical.version,snapshotSha256:canonical.data.snapshotSha256||null,migrationSnapshot:immutableMigrationSnapshot,snapshot:parsed.parsed});
    }
    if(freshMatch)throw new Error("Fresh canonical installation marker has no committed full-state snapshot; startup stopped");
    if(markerMatch){
      const original=await this.repository.readMigrationSnapshot(markerMatch[1]);
      if(!original?.raw||original.sourceKey!==AURELIA_LEGACY_STATE_KEY)throw new Error("Verified migration marker has no matching immutable source snapshot; startup stopped");
      const parsed=parseLegacyPmsSnapshot(original.raw),rows=await this.repository.listEntities("legacy"),expected=Object.entries(parsed.parsed);
      if(rows.length!==expected.length)throw new Error("Verified migration source entity count no longer matches its immutable snapshot");
      const actual=new Map(rows.map(row=>[row.id,row]));
      for(const [key,value] of expected){const row=actual.get(key);if(!row||row.version!==1||JSON.stringify(row.data)!==JSON.stringify(value))throw new Error("Verified migration source read-back mismatch for "+key)}
      return Object.freeze({restored:false,source:"canonical-migration-snapshot",migrationAlreadyVerified:false,migrationId:markerMatch[1],snapshot:parsed.parsed,migrationSnapshot:parsed.parsed});
    }
    const migrated=await this.repository.listEntities("legacy");
    if(migrated.length)throw new Error("Canonical PMS records exist but no committed full-state recovery snapshot is available; startup stopped to prevent an empty-state overwrite");
    return Object.freeze({restored:false,source:"no-existing-pms-data"});
  }


  async executeGuardedMigration() {
    await assertCompatibilityUiAllowed(this.bridge);
    const rawAtStart=this.storage.getItem(AURELIA_LEGACY_STATE_KEY);
    const marker=this.storage.getItem(AURELIA_MIGRATION_STATUS_KEY);
    const freshMatch=typeof marker==="string"&&marker.match(/^READY_CANONICAL:(mig_legacy_(?:[a-f0-9]{8}|[a-f0-9]{64}))$/);
    const markerMatch=typeof marker==="string"&&marker.match(/^VERIFIED:(mig_legacy_(?:[a-f0-9]{8}|[a-f0-9]{64}))$/);
    const latest=await this.repository.getEntity("audit",PMS_LEGACY_SNAPSHOT_ENTITY_ID);
    if(latest&&(!latest.data?.snapshot||typeof latest.data.snapshot!=="object"||Array.isArray(latest.data.snapshot)))throw new Error("Canonical audit snapshot exists without a valid full-state snapshot; startup stopped");
    const latestSnapshot=latest?.data?.snapshot?parseLegacyPmsSnapshot(JSON.stringify(latest.data.snapshot)).parsed:null;
    const legacyRows=await this.repository.listEntities("legacy");

    if(freshMatch){
      if(legacyRows.length)throw new Error("Fresh canonical installation unexpectedly contains legacy migration rows; startup stopped");
      if(!latestSnapshot)throw new Error("Fresh canonical installation marker has no committed recovery snapshot; startup stopped");
      return Object.freeze({status:"READY_CANONICAL",migrated:false,alreadyMigrated:true,freshInstallation:true,migrationId:freshMatch[1],entityCount:0,legacyKeyPreserved:rawAtStart!=null,snapshot:latestSnapshot});
    }
    if(markerMatch){
      const migrationId=markerMatch[1],original=await this.repository.readMigrationSnapshot(migrationId);
      if(!original?.raw||original.sourceKey!==AURELIA_LEGACY_STATE_KEY)throw new Error("Verified migration marker has no matching immutable source snapshot; startup stopped");
      const originalSnapshot=parseLegacyPmsSnapshot(original.raw),expected=Object.entries(originalSnapshot.parsed);
      if(legacyRows.length!==expected.length)throw new Error("Verified migration source entity count no longer matches its immutable snapshot");
      const actual=new Map(legacyRows.map(row=>[row.id,row]));
      for(const [key,value] of expected){const row=actual.get(key);if(!row||row.version!==1||JSON.stringify(row.data)!==JSON.stringify(value))throw new Error("Verified migration source read-back mismatch for "+key)}
      if(!latestSnapshot&&rawAtStart!==original.raw)throw new Error("Legacy PMS cache differs from its immutable migration source but no committed canonical snapshot exists; startup stopped");
      return Object.freeze({status:"MIGRATION_VERIFIED",migrated:false,alreadyMigrated:true,migrationId,entityCount:legacyRows.length,legacyKeyPreserved:rawAtStart!=null,snapshot:latestSnapshot||originalSnapshot.parsed,migrationSnapshot:originalSnapshot.parsed});
    }
    if(legacyRows.length){
      if(!latestSnapshot)throw new Error("Legacy migration marker is missing and no canonical recovery snapshot exists; startup stopped");
      throw new Error("Canonical legacy rows exist without a verified migration marker; startup stopped");
    }
    if(latestSnapshot){
      const canonicalRaw=JSON.stringify(latestSnapshot),migrationId=await stableMigrationId(canonicalRaw);
      this.storage.setItem(AURELIA_MIGRATION_STATUS_KEY,"READY_CANONICAL:"+migrationId);
      if(this.storage.getItem(AURELIA_MIGRATION_STATUS_KEY)!=="READY_CANONICAL:"+migrationId)throw new Error("Fresh canonical installation marker failed exact read-back verification");
      return Object.freeze({status:"READY_CANONICAL",migrated:false,alreadyMigrated:true,freshInstallation:true,migrationId,entityCount:0,legacyKeyPreserved:rawAtStart!=null,snapshot:latestSnapshot});
    }
    if(rawAtStart==null||rawAtStart==="")return Object.freeze({status:"READY_EMPTY",migrated:false,entityCount:0,legacyKeyPreserved:false});
    const snapshot=parseLegacyPmsSnapshot(rawAtStart),migrationId=await stableMigrationId(rawAtStart),sourceKey=AURELIA_LEGACY_STATE_KEY;
    const result=await this.repository.migrateLegacySnapshot(snapshot,{migrationId,sourceKey,sourceTimestamp:this.now()});
    const storedSnapshot=await this.repository.readMigrationSnapshot(migrationId);
    if(!storedSnapshot||storedSnapshot.raw!==rawAtStart||storedSnapshot.sourceKey!==sourceKey)throw new Error("Legacy migration rejected: exact raw snapshot read-back mismatch");
    const rows=await this.repository.listEntities("legacy"),expected=Object.entries(snapshot.parsed);
    if(rows.length!==expected.length)throw new Error("Legacy migration rejected: imported entity count mismatch");
    const actual=new Map(rows.map(row=>[row.id,row]));
    for(const [key,value] of expected){const row=actual.get(key);if(!row||row.version!==1||JSON.stringify(row.data)!==JSON.stringify(value))throw new Error("Legacy migration rejected: read-back mismatch for "+key)}
    this.storage.setItem(AURELIA_MIGRATION_STATUS_KEY,"VERIFIED:"+migrationId);
    if(this.storage.getItem(AURELIA_LEGACY_STATE_KEY)!==rawAtStart)throw new Error("Legacy migration source changed during verification; startup stopped");
    return Object.freeze({status:"MIGRATION_VERIFIED",migrated:!result.alreadyMigrated,alreadyMigrated:Boolean(result.alreadyMigrated),migrationId,entityCount:rows.length,legacyKeyPreserved:true,snapshot:snapshot.parsed,migrationSnapshot:snapshot.parsed});
  }

}

export const bootstrapper = new PmsBootstrapCoordinator();
