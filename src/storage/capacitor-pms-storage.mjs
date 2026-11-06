import { registerPlugin } from "@capacitor/core";
import { PmsRepository, assertPmsIdentity, assertPmsVersion } from "./pms-repository-contract.mjs";

const NativePmsStorage = registerPlugin("CapacitorPmsStorage");
const ident = (v,n) => assertPmsIdentity(v,n);
const version = (v,n="version") => assertPmsVersion(v,n);

export class CapacitorPmsStorageClient extends PmsRepository {
  constructor(plugin = NativePmsStorage) { super(); this.plugin = plugin; }

  async initializeStorage() {
    const result = await this.plugin.initializeStorage();
    if (!result || result.success !== true || result.engine !== "android-sqlite" || result.contractVersion !== 1) {
      throw new Error("Native PMS storage did not confirm the supported SQLite contract");
    }
    return result;
  }

  async getEntity(entityType, entityId) {
    ident(entityType,"entity type"); ident(entityId,"entity ID");
    const result = await this.plugin.getEntity({entityType,entityId});
    return result?.entity ?? null;
  }

  async listEntities(entityType) {
    ident(entityType,"entity type");
    const result = await this.plugin.listEntities({entityType});
    if (!Array.isArray(result?.entities)) throw new Error("Native SQLite returned an invalid entity list");
    return result.entities;
  }

  async transactBusinessChange({entityType,entityId,expectedVersion,event},apply) {
    ident(entityType,"entity type"); ident(entityId,"entity ID"); version(expectedVersion,"expected entity version");
    if(typeof apply!=="function")throw new TypeError("Mutation callback required");
    const current=await this.getEntity(entityType,entityId), liveVersion=current?.version??0;
    if(liveVersion!==expectedVersion){const e=new Error("Entity version conflict");e.code="ENTITY_VERSION_CONFLICT";e.actualVersion=liveVersion;throw e;}
    const nextData=apply({data:current?.data??null,version:liveVersion});
    if(nextData&&typeof nextData.then==="function")throw new TypeError("Mutation callback must be synchronous; prepare asynchronous work before opening the transaction");
    if(nextData===undefined)throw new Error("Mutation must return entity data");
    const committed=await this.plugin.transactBusinessChange({entityType,entityId,expectedVersion,data:nextData,event});
    if(!committed||committed.version!==expectedVersion+1)throw new Error("Native PMS transaction returned an invalid committed version");
    return {key:entityType+":"+entityId,type:entityType,id:entityId,version:committed.version,data:committed.data,updatedAt:Date.now()};
  }

  async migrateLegacySnapshot(snapshot,{migrationId,sourceKey,sourceTimestamp=new Date().toISOString()}={}) {
    if(!snapshot||typeof snapshot.raw!=="string"||!snapshot.raw)throw new TypeError("Exact raw legacy JSON snapshot is required");
    ident(migrationId,"migration ID");ident(sourceKey,"source key");
    if(!Number.isFinite(Date.parse(sourceTimestamp)))throw new TypeError("Invalid migration source timestamp");
    return this.plugin.migrateLegacySnapshot({migrationId,sourceKey,sourceTimestamp,raw:snapshot.raw});
  }

  async readMigrationSnapshot(migrationId) {
    ident(migrationId,"migration ID");
    const result=await this.plugin.readMigrationSnapshot({migrationId});
    return result?.snapshot??null;
  }

  async claimOutboxBatch({deviceId,limit=50,leaseMs=60000}={}) {
    ident(deviceId,"device ID");
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new TypeError("Batch limit must be 1..100");
    if(!Number.isSafeInteger(leaseMs)||leaseMs<1000||leaseMs>3600000)throw new TypeError("Lease must be 1000..3600000ms");
    const result=await this.plugin.claimOutboxBatch({deviceId,limit,leaseMs});
    if(!Array.isArray(result?.events))throw new Error("Native SQLite returned an invalid outbox batch");
    return result.events;
  }

  async acknowledgeOutbox({deviceId,acknowledgements}) {
    ident(deviceId,"device ID");
    if(!Array.isArray(acknowledgements)||!acknowledgements.length||acknowledgements.length>100)throw new TypeError("Invalid acknowledgements");
    return this.plugin.acknowledgeOutbox({deviceId,acknowledgements});
  }

  async retryOutbox({deviceId,eventId,retryAt,errorCode}) {
    ident(deviceId,"device ID");ident(eventId,"event ID");ident(errorCode,"error code");
    if(typeof retryAt!=="string"||!Number.isFinite(Date.parse(retryAt)))throw new TypeError("Invalid retry timestamp");
    await this.plugin.retryOutbox({deviceId,eventId,retryAt,errorCode});return true;
  }

  async markOutboxConflict({deviceId,eventId,conflictCode}) {
    ident(deviceId,"device ID");ident(eventId,"event ID");ident(conflictCode,"conflict code");
    await this.plugin.markOutboxConflict({deviceId,eventId,conflictCode});return true;
  }
}

export const capacitorPmsStorage = new CapacitorPmsStorageClient();
