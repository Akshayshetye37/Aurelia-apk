/**
 * Local-first sync foundation. No transport is enabled here.
 * A repository MUST atomically commit the business mutation and outbox event
 * in one SQLite transaction (Android) or one IndexedDB readwrite transaction.
 * A separate key-value shadow store is not an atomic adapter.
 */
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const EVENT=/^[A-Z][A-Z0-9_]{1,79}$/;
const SECRET=/(?:password|secret|credential|private.?key|access.?token|refresh.?token|authorization|cvv|card.?number)/i;
const fail=(code,message)=>Object.assign(new Error(message),{code});
function id(v,label){if(typeof v!=="string"||!ID.test(v))throw new TypeError("Invalid "+label);return v;}
function obj(v,label){if(!v||typeof v!=="object"||Array.isArray(v)||(Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null))throw new TypeError(label+" must be a plain object");return v;}
function inspect(v,path="payload"){
 if(v===null||["string","boolean"].includes(typeof v))return;
 if(typeof v==="number"){if(!Number.isFinite(v))throw new TypeError("Invalid number at "+path);return;}
 if(Array.isArray(v)){if(v.length>1000)throw new TypeError("Array too large at "+path);v.forEach((x,i)=>inspect(x,path+"["+i+"]"));return;}
 obj(v,"Payload value");
 for(const [k,x] of Object.entries(v)){if(SECRET.test(k))throw fail("SYNC_SENSITIVE_FIELD","Sensitive field prohibited: "+path+"."+k);inspect(x,path+"."+k);}
}
function copyPayload(v){obj(v,"Event payload");inspect(v);const s=JSON.stringify(v);if(new TextEncoder().encode(s).byteLength>65536)throw new TypeError("Payload exceeds 64 KiB");return JSON.parse(s);}
export function validateSyncEndpoint(input){
 if(input==null||String(input).trim()==="")return "";
 let u;try{u=new URL(String(input).trim());}catch{throw fail("SYNC_ENDPOINT_INVALID","Enter a valid HTTPS endpoint");}
 const h=u.hostname.toLowerCase().replace(/^\[|\]$/g,"");
 const privateV4=/^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
 if(u.protocol!=="https:"||u.username||u.password||u.search||u.hash||u.port&&u.port!=="443"||
 h==="localhost"||h.endsWith(".localhost")||h.endsWith(".local")||h==="::1"||h.startsWith("fc")||h.startsWith("fd")||h.startsWith("fe80:")||privateV4.test(h)||/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h))
 throw fail("SYNC_ENDPOINT_UNSAFE","Endpoint must be public HTTPS without credentials, query or fragment");
 return u.toString().replace(/\/$/,"");
}
export function normalizeSyncConfig(input={}){
 obj(input,"Sync configuration");const enabled=input.enabled===true,endpoint=validateSyncEndpoint(input.endpoint||"");
 if(enabled&&!endpoint)throw fail("SYNC_ENDPOINT_REQUIRED","Configure an endpoint before enabling sync");
 return Object.freeze({enabled,endpoint,schemaVersion:1});
}
export function createSyncEvent(e){
 obj(e,"Sync event");
 if(!EVENT.test(String(e.eventType||"")))throw new TypeError("Invalid event type");
 if(!Number.isSafeInteger(e.sequence)||e.sequence<1||!Number.isSafeInteger(e.schemaVersion||1)||(e.schemaVersion||1)<1)throw new TypeError("Invalid event sequence/schema version");
 const at=new Date(e.occurredAt);if(!Number.isFinite(at.getTime()))throw new TypeError("Invalid event timestamp");
 return Object.freeze({eventId:id(e.eventId,"event ID"),tenantId:id(e.tenantId,"tenant ID"),propertyId:id(e.propertyId,"property ID"),deviceId:id(e.deviceId,"device ID"),entityType:id(e.entityType,"entity type"),entityId:id(e.entityId,"entity ID"),sequence:e.sequence,schemaVersion:e.schemaVersion||1,eventType:e.eventType,occurredAt:at.toISOString(),payload:copyPayload(e.payload)});
}
/**
 * Adapter methods:
 * transactBusinessChange({entityType,entityId,expectedVersion,event}, apply)
 * claimOutboxBatch({deviceId,limit}), acknowledgeOutbox({deviceId,acknowledgements}),
 * retryOutbox({deviceId,eventId,retryAt,errorCode}), markOutboxConflict({deviceId,eventId,conflictCode}).
 * The first MUST version-check, mutate the entity and append event atomically.
 */
export class LocalSyncCoordinator{
 constructor({repository,config={},identity,now=()=>new Date().toISOString()}={}){
  for(const m of ["transactBusinessChange","claimOutboxBatch","acknowledgeOutbox","retryOutbox","markOutboxConflict"])if(typeof repository?.[m]!=="function")throw new TypeError("Durable transactional sync repository adapter required: "+m);
  obj(identity,"Device identity");for(const k of ["tenantId","propertyId","deviceId"])id(identity[k],k);
  this.repository=repository;this.config=normalizeSyncConfig(config);this.identity={tenantId:identity.tenantId,propertyId:identity.propertyId,deviceId:identity.deviceId};this.now=now;
 }
 get status(){return Object.freeze({enabled:this.config.enabled,endpointConfigured:!!this.config.endpoint,transportAvailable:false,mode:this.config.enabled?"SYNC_CONFIGURED_TRANSPORT_NOT_INSTALLED":"LOCAL_ONLY"});}
 async commit({entityType,entityId,expectedVersion,eventType,payload,apply}){
  if(typeof apply!=="function")throw new TypeError("Business mutation callback required");
  if(!Number.isSafeInteger(expectedVersion)||expectedVersion<0)throw new TypeError("Expected entity version required");
  const event=createSyncEvent({eventId:id("evt-"+this.identity.deviceId+"-"+String(this.now()).replace(/\D/g,"")+"-"+expectedVersion,"event ID"),...this.identity,entityType,entityId,sequence:expectedVersion+1,eventType,payload,occurredAt:this.now(),schemaVersion:1});
  return this.repository.transactBusinessChange({entityType:event.entityType,entityId:event.entityId,expectedVersion,event},apply);
 }
 async claimBatch({limit=50}={}){if(!this.config.enabled)return[];if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new TypeError("Batch limit must be 1..100");return this.repository.claimOutboxBatch({deviceId:this.identity.deviceId,limit});}
 async acknowledge(rows){if(!this.config.enabled)throw fail("SYNC_DISABLED","Cloud sync is disabled");if(!Array.isArray(rows)||!rows.length||rows.length>100)throw new TypeError("Acknowledgements must contain 1..100 rows");const a=rows.map(r=>{obj(r,"Acknowledgement");if(!Number.isSafeInteger(r.sequence)||r.sequence<1)throw new TypeError("Invalid acknowledgement sequence");return{eventId:id(r.eventId,"event ID"),sequence:r.sequence};});return this.repository.acknowledgeOutbox({deviceId:this.identity.deviceId,acknowledgements:a});}
 async retry(eventId,errorCode="TRANSPORT_ERROR"){if(!this.config.enabled)throw fail("SYNC_DISABLED","Cloud sync is disabled");return this.repository.retryOutbox({deviceId:this.identity.deviceId,eventId:id(eventId,"event ID"),retryAt:this.now(),errorCode:id(errorCode,"error code")});}
 async quarantineConflict(eventId,conflictCode){if(!this.config.enabled)throw fail("SYNC_DISABLED","Cloud sync is disabled");return this.repository.markOutboxConflict({deviceId:this.identity.deviceId,eventId:id(eventId,"event ID"),conflictCode:id(conflictCode,"conflict code")});}
}
