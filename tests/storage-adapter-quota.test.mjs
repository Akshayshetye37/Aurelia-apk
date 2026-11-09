import test from "node:test";
import assert from "node:assert/strict";
import { StorageFullError } from "../src/storage/web-storage-adapter.mjs";
import { createIndexedDbStorageAdapter } from "../src/storage/indexeddb-storage-adapter.mjs";
import { createSqliteStorageAdapter } from "../src/storage/sqlite-storage-adapter.mjs";

test("IndexedDB transaction aborts with QuotaExceededError become typed StorageFullError",async()=>{const quota=new DOMException("quota exceeded","QuotaExceededError");const repository={async database(){return{transaction(){const tx={error:null,objectStore(){return{put(){tx.error=quota;throw quota;}}},abort(){tx.error=quota;queueMicrotask(()=>tx.onabort?.());}};return tx;}}}};const adapter=createIndexedDbStorageAdapter(repository);await assert.rejects(adapter.transaction(tx=>tx.put("meta","x",{value:1})),error=>error instanceof StorageFullError&&error.code==="STORAGE_FULL"&&error.action==="EXPORT_DATA");});

test("native SQLite quota failures are normalized to the shared StorageFullError",async()=>{
 const plugin={storageTransaction(){const error=new Error("disk full");error.code="STORAGE_FULL";return Promise.reject(error);}};
 const adapter=createSqliteStorageAdapter(plugin);
 await assert.rejects(adapter.put("meta","x",{value:1}),error=>error instanceof StorageFullError&&error.code==="STORAGE_FULL"&&error.action==="EXPORT_DATA");
});
