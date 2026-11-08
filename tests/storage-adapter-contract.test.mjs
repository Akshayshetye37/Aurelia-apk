import test,{describe} from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { IndexedDbPmsRepository } from "../src/storage/indexeddb-pms-repository.mjs";
import { createIndexedDbStorageAdapter } from "../src/storage/indexeddb-storage-adapter.mjs";
import { createSqliteStorageAdapter } from "../src/storage/sqlite-storage-adapter.mjs";
function fakeSqlitePlugin(){const stores=new Map(["meta","entities","outbox","migration_snapshots","legacy_backup"].map(k=>[k,new Map()]));let authority="legacy";const copy=x=>x==null?x:structuredClone(x);return{async storageGet({store,key}){return{value:copy(stores.get(store)?.get(key)??null)}},async storageList({store}){return{rows:[...(stores.get(store)?.values()||[])].map(copy)}},async storageTransaction({operations}){const staged=new Map([...stores].map(([k,v])=>[k,new Map([...v].map(([x,y])=>[x,copy(y)]))]));for(const op of operations){if(op.type!=="put"||!staged.has(op.store))throw Error("invalid operation");staged.get(op.store).set(op.key,copy(op.value));}for(const [k,v] of staged)stores.set(k,v);return{success:true}},async storageIntegrityCheck(){return{ok:true,engine:"android-sqlite",result:"ok"}},async storageGetAuthority(){return{state:authority}},async storageSetAuthority({state}){if(authority==="canonical"&&state!=="canonical")throw Error("cannot downgrade");authority=state;return{state}}};}
const adapters=[
 ["IndexedDB",async()=>createIndexedDbStorageAdapter(new IndexedDbPmsRepository({indexedDBImpl:indexedDB,databaseName:"storage-contract-"+Math.random().toString(36).slice(2)}))],
 ["SQLite bridge adapter",async()=>createSqliteStorageAdapter(fakeSqlitePlugin())]
];
for(const [name,create] of adapters){describe("StorageAdapter contract: "+name,()=>{
 test("transaction commits entity, meta and backup writes as one unit",async()=>{const a=await create();await a.transaction(tx=>{tx.put("entities","guest:g1",{key:"guest:g1",type:"guest",id:"g1",version:1,data:{name:"Guest"}});tx.meta.put("migration_verified",{value:true});tx.backup.put("migration-1",{raw:"{\"guest\":[]}",sha256:"abc"});});assert.equal((await a.get("entities","guest:g1")).data.name,"Guest");assert.equal((await a.getMeta("migration_verified")).value,true);assert.equal((await a.getBackup("migration-1")).sha256,"abc");assert.equal((await a.list("entities")).length,1);assert.ok((await a.list("meta")).some(row=>row.key==="migration_verified"));assert.equal((await a.list("legacy_backup")).length,1);});
 test("transaction callback cannot await non-database work",async()=>{const a=await create();await assert.rejects(a.transaction(async tx=>{tx.meta.put("must-not-commit",{value:true});await Promise.resolve();}),/must be synchronous/);assert.equal(await a.getMeta("must-not-commit"),null);});
 test("integrity and authority methods return the common contract shape",async()=>{const a=await create();const integrity=await a.integrityCheck();assert.equal(integrity.ok,true);assert.equal(await a.authority(),"legacy");});
});}
