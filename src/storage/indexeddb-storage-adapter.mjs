import { StorageAdapter, assertStorageAdapter } from "./storage-adapter.mjs";
import { StorageFullError } from "./web-storage-adapter.mjs";
const STORES=new Set(["meta","entities","outbox","migration_snapshots","legacy_backup"]);
const clone=x=>x==null?x:structuredClone(x);
const isQuota=e=>e?.name==="QuotaExceededError"||e?.cause?.name==="QuotaExceededError";
const storageError=e=>isQuota(e)?new StorageFullError(undefined,{cause:e}):(e||new Error("IndexedDB operation failed"));
const req=r=>new Promise((ok,no)=>{r.onsuccess=()=>ok(r.result);r.onerror=()=>no(storageError(r.error||new Error("IndexedDB request failed")));});
const done=t=>new Promise((ok,no)=>{t.oncomplete=ok;t.onerror=t.onabort=()=>no(storageError(t.error||new Error("IndexedDB transaction failed")));});
function rowFor(store,key,value){if(!STORES.has(store))throw new TypeError("Unsupported storage store: "+store);const row=clone(value);if(!row||typeof row!=="object"||Array.isArray(row))throw new TypeError("Storage rows must be objects");const field={meta:"key",entities:"key",outbox:"eventId",migration_snapshots:"id",legacy_backup:"id"}[store];if(field&&row[field]!==key)row[field]=key;return row;}
export class IndexedDbStorageAdapter extends StorageAdapter{
 constructor(repository){super();if(!repository||typeof repository.database!=="function")throw new TypeError("IndexedDB repository required");this.repository=repository;}
 async transaction(fn){
  if(typeof fn!=="function")throw new TypeError("transaction callback required");
  const ops=[];
  const writer={
   put(store,key,value){ops.push({type:"put",store,key,value:clone(value)});},
   compareAndPut(store,key,expectedVersion,value){ops.push({type:"comparePut",store,key,expectedVersion,value:clone(value)});},
   meta:{put(key,value){ops.push({type:"put",store:"meta",key,value:clone(value)});}},
   backup:{put(key,value){ops.push({type:"put",store:"legacy_backup",key,value:clone(value)});}}
  };
  Object.freeze(writer.meta);Object.freeze(writer.backup);Object.freeze(writer);
  const result=fn(writer);
  if(result&&typeof result.then==="function")throw new TypeError("StorageAdapter transaction callback must be synchronous; stage DB writes only");
  if(!ops.length)return result;
  const stores=[...new Set(ops.map(x=>x.store))],db=await this.repository.database(),tx=db.transaction(stores,"readwrite"),completion=done(tx);
  try{for(const op of ops){if(op.type==="comparePut"){if(op.store!=="entities")throw new TypeError("compareAndPut is supported only for entities");const current=await req(tx.objectStore(op.store).get(op.key)),actual=current?.version||0;if(actual!==op.expectedVersion)throw Object.assign(new Error("Storage entity version conflict"),{code:"ENTITY_VERSION_CONFLICT",actualVersion:actual});}tx.objectStore(op.store).put(rowFor(op.store,op.key,op.value));}await completion;return result;}
  catch(e){try{tx.abort()}catch{}await completion.catch(()=>{});throw storageError(e);}
 }
 async get(store,key){if(!STORES.has(store))throw new TypeError("Unsupported storage store: "+store);const db=await this.repository.database(),tx=db.transaction(store,"readonly"),completion=done(tx),value=await req(tx.objectStore(store).get(key));await completion;return value==null?null:clone(value);}
 async put(store,key,value){return this.transaction(tx=>tx.put(store,key,value));}
 async list(store){if(!STORES.has(store))throw new TypeError("Unsupported storage store: "+store);const db=await this.repository.database(),tx=db.transaction(store,"readonly"),completion=done(tx),rows=await req(tx.objectStore(store).getAll());await completion;return rows.map(clone);}
 getMeta(key){return this.get("meta",key);}
 putMeta(key,value){return this.put("meta",key,{...value,key});}
 getBackup(id){return this.get("legacy_backup",id);}
 putBackup(id,value){return this.put("legacy_backup",id,{...value,id});}
 async integrityCheck(){const db=await this.repository.database();const missing=[...STORES].filter(name=>!db.objectStoreNames.contains(name));if(missing.length)throw new Error("IndexedDB schema is missing stores: "+missing.join(", "));return{ok:true,engine:"indexeddb",version:db.version};}
 async authority(){return this.repository.getAuthority();}
 async authorityRecord(){return this.repository.getAuthorityRecord();}
 async setAuthorityRecord(record){const state=record?.value||"legacy";if(state==="canonical"){if(record.freshInstallation)return this.repository.completeFreshCanonicalAuthority();return this.repository.completeMigrationAuthority(record.migrationId);}if(state==="migrating")return this.repository.beginMigrationAuthority();return this.repository.revertMigrationAuthority();}
 async wipe(){const db=await this.repository.database(),names=Array.from(db.objectStoreNames),tx=db.transaction(names,"readwrite"),completion=done(tx);for(const name of names)tx.objectStore(name).clear();await completion;return true;}
}
export function createIndexedDbStorageAdapter(repository){return assertStorageAdapter(new IndexedDbStorageAdapter(repository));}
