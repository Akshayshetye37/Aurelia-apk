/**
 * Aurelia PMS repository bridge.
 *
 * IndexedDB and native SQLite are asynchronous engines. Domain entry points
 * therefore return Promises; pretending they are synchronous would either block
 * the WebView or reintroduce an unsafe localStorage shadow-write path.
 *
 * Every mutation delegates to transactBusinessChange(), whose adapter commits
 * the entity version and immutable outbox event in one engine transaction.
 */
import { buildPmsOutboxEvent, PMS_ENTITY_TYPES, assertPmsIdentity, assertPmsVersion } from "./pms-repository-contract.mjs";

const clone = value => value == null ? value :
  (typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value)));

function makeEventId() {
  if (globalThis.crypto?.randomUUID) return "evt_" + globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (!globalThis.crypto?.getRandomValues) throw new Error("Cryptographically secure event ID generation is unavailable");
  globalThis.crypto.getRandomValues(bytes);
  return "evt_" + Array.from(bytes, x => x.toString(16).padStart(2, "0")).join("");
}

export class PmsRepositoryBridge {
  constructor({ tenantId, propertyId, deviceId, now = () => new Date().toISOString(), eventId = makeEventId } = {}) {
    this.repo = null;
    this.context = { tenantId, propertyId, deviceId };
    this.now = now;
    this.eventId = eventId;
    this.compatibilityWrite = Promise.resolve();
  }

  bindActiveEngine(repositoryInstance, context = {}) {
    if (!repositoryInstance ||
        typeof repositoryInstance.getEntity !== "function" ||
        typeof repositoryInstance.transactBusinessChange !== "function" || typeof repositoryInstance.transactBusinessBatch !== "function") {
      throw new TypeError("Repository does not implement the Aurelia PMS repository contract");
    }
    this.repo = repositoryInstance;
    this.context = { ...this.context, ...context };
    return this;
  }

  assertBound() {
    if (!this.repo) throw new Error("Storage bridge is not bound to a verified repository");
  }

  async fetchEntity(entityType, entityId) {
    this.assertBound();
    assertPmsIdentity(entityType, "entity type");
    assertPmsIdentity(entityId, "entity ID");
    const row = await this.repo.getEntity(entityType, entityId);
    return row ? clone(row) : null;
  }

  async mutateEntity({ entityType, entityId, expectedVersion, eventType, mutate, tenantId, propertyId, deviceId, eventPayload }) {
    this.assertBound();
    assertPmsIdentity(entityType, "entity type");
    assertPmsIdentity(entityId, "entity ID");
    assertPmsIdentity(eventType, "event type");
    assertPmsVersion(expectedVersion, "expected version");
    if (typeof mutate !== "function") throw new TypeError("A synchronous mutation callback is required");
    const context = {
      tenantId: tenantId || this.context.tenantId,
      propertyId: propertyId || this.context.propertyId,
      deviceId: deviceId || this.context.deviceId
    };
    for (const [value, label] of [[context.tenantId, "tenant ID"], [context.propertyId, "property ID"], [context.deviceId, "device ID"]]) {
      assertPmsIdentity(value, label);
    }

    let result;
    const event = buildPmsOutboxEvent({
      eventId: this.eventId(),
      ...context,
      entityType,
      entityId,
      sequence: expectedVersion + 1,
      eventType,
      schemaVersion: 1,
      occurredAt: this.now(),
      payload: eventPayload || { entityType, entityId, operation: eventType }
    });
    const committed = await this.repo.transactBusinessChange(
      { entityType, entityId, expectedVersion, event },
      ({ data, version }) => {
        if (version !== expectedVersion) {
          const error = new Error("Entity version conflict");
          error.code = "ENTITY_VERSION_CONFLICT";
          error.actualVersion = version;
          throw error;
        }
        const working = data == null ? { id: entityId } : clone(data);
        result = mutate(working);
        if (result && typeof result.then === "function") {
          throw new TypeError("Mutation callback must be synchronous; prepare asynchronous work before calling mutateEntity");
        }
        return working;
      }
    );
    return Object.freeze({ entity: clone(committed), result: clone(result) });
  }

  async mutateEntities(changes) {
    this.assertBound();
    if(!Array.isArray(changes)||changes.length<2||changes.length>20)throw new TypeError("A multi-entity mutation requires 2..20 changes");
    const seen=new Set(),eventIds=new Set(),prepared=[];
    for(const input of changes){const entityType=assertPmsIdentity(input?.entityType,"entity type"),entityId=assertPmsIdentity(input?.entityId,"entity ID"),eventType=assertPmsIdentity(input?.eventType,"event type");assertPmsVersion(input?.expectedVersion,"expected version");if(typeof input.mutate!=="function")throw new TypeError("Every batch change requires a synchronous mutation callback");const key=entityType+":"+entityId;if(seen.has(key))throw new TypeError("Duplicate entity in multi-entity mutation");seen.add(key);const row=await this.fetchEntity(entityType,entityId),version=row?.version??0;if(version!==input.expectedVersion){const error=new Error("Entity version conflict");error.code="ENTITY_VERSION_CONFLICT";error.entityType=entityType;error.entityId=entityId;error.actualVersion=version;throw error;}const scope={tenantId:input.tenantId||this.context.tenantId,propertyId:input.propertyId||this.context.propertyId,deviceId:input.deviceId||this.context.deviceId};for(const [value,label] of [[scope.tenantId,"tenant ID"],[scope.propertyId,"property ID"],[scope.deviceId,"device ID"]])assertPmsIdentity(value,label);const working=row?clone(row.data):{id:entityId};const result=input.mutate(working);if(result&&typeof result.then==="function")throw new TypeError("Batch mutation callbacks must be synchronous");const event=buildPmsOutboxEvent({eventId:this.eventId(),...scope,entityType,entityId,sequence:version+1,eventType,schemaVersion:1,occurredAt:this.now(),payload:input.eventPayload||{entityType,entityId,operation:eventType}});if(eventIds.has(event.eventId))throw new TypeError("Duplicate outbox event ID");eventIds.add(event.eventId);prepared.push({entityType,entityId,expectedVersion:version,data:working,event,result});}
    const committed=await this.repo.transactBusinessBatch(prepared.map(({entityType,entityId,expectedVersion,data,event})=>({entityType,entityId,expectedVersion,data,event})));
    return Object.freeze({entities:committed.map(clone),results:prepared.map(x=>clone(x.result))});
  }

  persistCompatibilitySnapshot(snapshot) {
    this.assertBound();
    const serialized = JSON.stringify(snapshot);
    if (typeof serialized !== "string") return Promise.reject(new TypeError("Compatibility snapshot must be JSON serializable"));
    const write = async () => {
      if (!globalThis.crypto?.subtle || !globalThis.TextEncoder) throw new Error("Secure snapshot digest is unavailable");
      const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
      const hash = Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, "0")).join("");
      let lastError;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const current = await this.fetchEntity("audit", "legacy_snapshot:aurelia_lodge_v2");
        try {
          return await this.mutateEntity({
            entityType: "audit", entityId: "legacy_snapshot:aurelia_lodge_v2", expectedVersion: current?.version ?? 0,
            eventType: "legacy.snapshot_saved",
            eventPayload: { sourceKey: "aurelia_lodge_v2", snapshotSha256: hash, byteLength: new TextEncoder().encode(serialized).length },
            mutate: entity => { entity.snapshot = JSON.parse(serialized); entity.snapshotSha256 = hash; entity.sourceKey = "aurelia_lodge_v2"; }
          });
        } catch (error) { lastError = error; if (error?.code !== "ENTITY_VERSION_CONFLICT") throw error; }
      }
      throw lastError || new Error("Compatibility snapshot version conflict retry limit exceeded");
    };
    this.compatibilityWrite = this.compatibilityWrite.then(write, write);
    return this.compatibilityWrite;
  }

  saveBooking(input) { return this.mutateEntity({ ...input, entityType: "booking", eventType: input.eventType || "booking.saved" }); }
  addLedgerLine(input) { return this.mutateEntity({ ...input, entityType: "ledger", eventType: input.eventType || "ledger.line_added" }); }
  mutateFolioState(input) { return this.mutateEntity({ ...input, entityType: "folio", eventType: input.eventType || "folio.updated" }); }
  saveGuest(input) { return this.mutateEntity({ ...input, entityType: "guest", eventType: input.eventType || "guest.saved" }); }
  saveRoom(input) { return this.mutateEntity({ ...input, entityType: "room", eventType: input.eventType || "room.saved" }); }
}

export const storageBridge = new PmsRepositoryBridge();
