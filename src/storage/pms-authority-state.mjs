export const PMS_AUTHORITY_ENTITY_ID="pms:authority";
export const PMS_AUTHORITY_STATUS=Object.freeze({PREPARED_COMPATIBILITY:"PREPARED_COMPATIBILITY",CANONICAL_AUTHORITATIVE:"CANONICAL_AUTHORITATIVE"});
function valid(row){
 if(!row||row.type!=="audit"||row.id!==PMS_AUTHORITY_ENTITY_ID||!Number.isSafeInteger(row.version)||row.version<1||!row.data||typeof row.data!=="object"||Array.isArray(row.data)||row.data.schemaVersion!==1||!Object.values(PMS_AUTHORITY_STATUS).includes(row.data.status)||row.data.uiCutover!==(row.data.status===PMS_AUTHORITY_STATUS.CANONICAL_AUTHORITATIVE)||!["NOT_REQUIRED","PENDING","VERIFIED"].includes(row.data.projectionStatus))throw Object.assign(new Error("Persisted PMS authority state is invalid; startup stopped"),{code:"PMS_AUTHORITY_STATE_INVALID"});
 return row;
}
export async function readPmsAuthorityState(bridge){if(!bridge||typeof bridge.fetchEntity!=="function")throw new TypeError("A bound PMS repository bridge is required");const row=await bridge.fetchEntity("audit",PMS_AUTHORITY_ENTITY_ID);return row?valid(row):null;}
export async function assertCompatibilityUiAllowed(bridge){const row=await readPmsAuthorityState(bridge);if(row?.data.status===PMS_AUTHORITY_STATUS.CANONICAL_AUTHORITATIVE)throw Object.assign(new Error("Canonical PMS authority is active; legacy compatibility UI startup is prohibited"),{code:"PMS_CANONICAL_AUTHORITY_CUTOVER_REQUIRED"});return row;}
export async function ensureCanonicalPrepared({bridge,migrationId=null,projectionStatus="NOT_REQUIRED",now=()=>new Date().toISOString()}={}){
 if(!bridge||typeof bridge.fetchEntity!=="function"||typeof bridge.mutateEntity!=="function")throw new TypeError("A bound PMS repository bridge is required");
 if(migrationId!==null&&(typeof migrationId!=="string"||!/^mig_legacy_[a-f0-9]{8}$/.test(migrationId)))throw new TypeError("Invalid canonical authority migration ID");
 if(!["NOT_REQUIRED","PENDING","VERIFIED"].includes(projectionStatus))throw new TypeError("Invalid canonical domain projection status");
 for(let attempt=0;attempt<4;attempt++){
  const current=await readPmsAuthorityState(bridge);
  if(current?.data.status===PMS_AUTHORITY_STATUS.CANONICAL_AUTHORITATIVE)throw Object.assign(new Error("Canonical authority is already active; compatibility preparation cannot downgrade it"),{code:"PMS_AUTHORITY_DOWNGRADE_BLOCKED"});
  if(current?.data.migrationId&&migrationId&&current.data.migrationId!==migrationId)throw Object.assign(new Error("Canonical authority migration identity changed; startup stopped"),{code:"PMS_AUTHORITY_MIGRATION_CONFLICT"});
  const next={schemaVersion:1,status:PMS_AUTHORITY_STATUS.PREPARED_COMPATIBILITY,uiCutover:false,migrationId:current?.data.migrationId||migrationId,projectionStatus:projectionStatus==="VERIFIED"?"VERIFIED":(current?.data.projectionStatus||projectionStatus),preparedAt:current?.data.preparedAt||now(),updatedAt:now()};
  if(current&&current.data.migrationId===next.migrationId&&current.data.projectionStatus===next.projectionStatus)return current;
  try{return valid((await bridge.mutateEntity({entityType:"audit",entityId:PMS_AUTHORITY_ENTITY_ID,expectedVersion:current?.version??0,eventType:current?"pms.authority_prepared":"pms.authority_initialized",eventPayload:{status:next.status,migrationId:next.migrationId,projectionStatus:next.projectionStatus},mutate:data=>Object.assign(data,next)})).entity);}
  catch(error){if(error?.code!=="ENTITY_VERSION_CONFLICT"||attempt===3)throw error;}
 }
 throw new Error("Canonical authority preparation retry limit exceeded");
}
