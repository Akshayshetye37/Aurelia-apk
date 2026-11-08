import { StorageAdapter, assertStorageAdapter } from "./storage-adapter.mjs";
const STORES=new Set(["meta","entities","outbox","migration_snapshots","legacy_backup"]);
export class SqliteStorageAdapter extends StorageAdapter{
 constructor(plugin){super();if(!plugin)throw new TypeError("Native SQLite plugin required");this.plugin=plugin;}
 async transaction(fn){
  if(typeof fn!=="function")throw new TypeError("transaction callback required");
  const operations=[];
  const writer={
   put(store,key,value){if(!STORES.has(store))throw new TypeError("Unsupported storage store: "+store);operations.push({type:"put",store,key,value});},
   meta:{put(key,value){operations.push({type:"put",store:"meta",key,value});}},
   backup:{put(key,value){operations.push({type:"put",store:"legacy_backup",key,value});}}
  };
  Object.freeze(writer.meta);Object.freeze(writer.backup);Object.freeze(writer);
  const result=fn(writer);
  if(result&&typeof result.then==="function")throw new TypeError("StorageAdapter transaction callback must be synchronous; stage DB writes only");
  if(operations.length)await this.plugin.storageTransaction({operations});
  return result;
 }
 async get(store,key){if(!STORES.has(store))throw new TypeError("Unsupported storage store: "+store);const r=await this.plugin.storageGet({store,key});return r?.value??null;}
 async put(store,key,value){if(!STORES.has(store))throw new TypeError("Unsupported storage store: "+store);await this.plugin.storageTransaction({operations:[{type:"put",store,key,value}]});return true;}
 async list(store){if(!STORES.has(store))throw new TypeError("Unsupported storage store: "+store);const r=await this.plugin.storageList({store});if(!Array.isArray(r?.rows))throw new Error("SQLite returned an invalid row list");return r.rows;}
 async getMeta(key){const value=await this.get("meta",key);return value==null?null:{...value,key};}
 putMeta(key,value){return this.put("meta",key,{...value,key});}
 async getBackup(id){const value=await this.get("legacy_backup",id);return value==null?null:{...value,id};}
 putBackup(id,value){return this.put("legacy_backup",id,{...value,id});}
 async integrityCheck(){const r=await this.plugin.storageIntegrityCheck();if(r?.ok!==true)throw new Error("SQLite integrity_check failed");return r;}
 async authority(){const r=await this.plugin.storageGetAuthority();if(!["legacy","migrating","canonical"].includes(r?.state))throw new Error("SQLite returned an invalid authority state");return r.state;}
 async setAuthority(state,migrationId=null){if(!["legacy","migrating","canonical"].includes(state))throw new TypeError("Invalid storage authority state");const r=await this.plugin.storageSetAuthority({state,migrationId});if(r?.state!==state)throw new Error("SQLite authority update read-back mismatch");return r.state;}
}
export function createSqliteStorageAdapter(plugin){return assertStorageAdapter(new SqliteStorageAdapter(plugin));}
