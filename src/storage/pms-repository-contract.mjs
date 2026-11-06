/** Shared contract and invariants for the IndexedDB and Android SQLite adapters.
 * All mutation callbacks are prepared before entering the native transaction.
 * Entity version increment and outbox append are one indivisible commit.
 */
export const PMS_REPOSITORY_CONTRACT_VERSION = 1;
export const PMS_ENTITY_TYPES = Object.freeze(["booking","folio","guest","room","room_block","inventory","ledger","audit"]);
export function assertPmsIdentity(value, label="identity") {
  if (typeof value !== "string" || !value.trim() || value.length > 180 || /[\\u0000-\\u001f]/.test(value)) throw new TypeError("Invalid " + label);
  return value;
}
export function assertPmsVersion(value, label="version") {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Invalid " + label);
  return value;
}
export function buildPmsOutboxEvent({eventId,tenantId,propertyId,deviceId,entityType,entityId,sequence,eventType,schemaVersion=1,occurredAt=new Date().toISOString(),payload}) {
  for (const [v,n] of [[eventId,"event ID"],[tenantId,"tenant ID"],[propertyId,"property ID"],[deviceId,"device ID"],[entityType,"entity type"],[entityId,"entity ID"],[eventType,"event type"]]) assertPmsIdentity(v,n);
  assertPmsVersion(sequence,"sequence"); if(sequence<1)throw new TypeError("Invalid sequence");
  if(!Number.isSafeInteger(schemaVersion)||schemaVersion<1)throw new TypeError("Invalid schema version");
  if(!Number.isFinite(Date.parse(occurredAt)))throw new TypeError("Invalid event timestamp");
  const encoded=JSON.stringify(payload); if(encoded===undefined)throw new TypeError("Payload must be JSON serializable");
  return Object.freeze({eventId,tenantId,propertyId,deviceId,entityType,entityId,sequence,eventType,schemaVersion,occurredAt,payload:JSON.parse(encoded)});
}
/** Adapter surface: getEntity, listEntities, transactBusinessChange,
 * claimOutboxBatch, acknowledgeOutbox, retryOutbox, markOutboxConflict,
 * migrateLegacySnapshot and readMigrationSnapshot. */
export class PmsRepository {
  getEntity(){throw new Error("Not implemented");}
  listEntities(){throw new Error("Not implemented");}
  transactBusinessChange(){throw new Error("Not implemented");}
  claimOutboxBatch(){throw new Error("Not implemented");}
  acknowledgeOutbox(){throw new Error("Not implemented");}
  retryOutbox(){throw new Error("Not implemented");}
  markOutboxConflict(){throw new Error("Not implemented");}
  migrateLegacySnapshot(){throw new Error("Not implemented");}
  readMigrationSnapshot(){throw new Error("Not implemented");}
}
