import test from "node:test";
import assert from "node:assert/strict";
import { createWebStorageAdapter } from "../src/storage/web-storage-adapter.mjs";

test("web storage adapter uses durable storage when available and reports persistence",()=>{
 const values=new Map(),backing={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)};
 const win={localStorage:backing,location:{href:"https://app.example/"},frameElement:null};
 const adapter=createWebStorageAdapter({windowRef:win});
 assert.equal(adapter.persistent,true);
 assert.equal(win.__aureliaStorage,adapter);
 adapter.setItem("legacy-import-marker","READY");
 assert.equal(backing.getItem("legacy-import-marker"),"READY");
 assert.equal(adapter.getItem("legacy-import-marker"),"READY");
 assert.equal(adapter.memoryOnly,false);
});

test("web storage adapter degrades explicitly to session memory when durable storage is blocked",()=>{
 const win={localStorage:{getItem(){throw new Error("blocked")},setItem(){throw new Error("blocked")},removeItem(){throw new Error("blocked")}},location:{href:"about:srcdoc"},frameElement:null};
 const adapter=createWebStorageAdapter({windowRef:win});
 assert.equal(adapter.persistent,false);
 assert.equal(adapter.memoryOnly,true);
 adapter.setItem("legacy-import-marker","READY");
 assert.equal(adapter.getItem("legacy-import-marker"),"READY");
 assert.equal(win.AureliaStorageDiagnostics.embeddedPreview,true);
});
