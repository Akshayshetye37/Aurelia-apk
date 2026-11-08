import test from "node:test";
import assert from "node:assert/strict";
import { createWebStorageAdapter, StorageFullError } from "../src/storage/web-storage-adapter.mjs";

test("quota failures become typed StorageFullError and never fall back to memory",()=>{
 const backing={
  getItem(){return null;},
  setItem(key,value){if(key==="__aurelia_storage_probe__")return;const error=new Error("quota exceeded");error.name="QuotaExceededError";throw error;},
  removeItem(){}
 };
 const adapter=createWebStorageAdapter({windowRef:{localStorage:backing,location:{href:"https://app.example"},frameElement:null}});
 assert.equal(adapter.persistent,true);
 assert.throws(()=>adapter.setItem("some-key","value"),error=>
  error instanceof StorageFullError && error.code==="STORAGE_FULL" && error.action==="EXPORT_DATA"
 );
 assert.equal(adapter.getItem("some-key"),null);
});

test("non-quota durable write failures propagate and do not become volatile writes",()=>{
 const backing={
  getItem(){return null;},
  setItem(key,value){if(key==="__aurelia_storage_probe__")return;const error=new Error("security denied");error.name="SecurityError";throw error;},
  removeItem(){}
 };
 const adapter=createWebStorageAdapter({windowRef:{localStorage:backing,location:{href:"https://app.example"},frameElement:null}});
 assert.throws(()=>adapter.setItem("some-key","value"),error=>error.name==="StorageWriteError");
 assert.equal(adapter.getItem("some-key"),null);
});
