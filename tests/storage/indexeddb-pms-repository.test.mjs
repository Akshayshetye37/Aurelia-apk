import test from "node:test";import fs from "node:fs";import path from "node:path";import assert from "node:assert/strict";import{indexedDB}from"fake-indexeddb";import{IndexedDbPmsRepository,parseLegacyPmsSnapshot}from"../../src/storage/indexeddb-pms-repository.mjs";
const state={rooms:[],b:[],g:[],t:[],exp:[],inv:[],led:[],aud:[],set:{name:"Aurelia"},menu:{},tab:"home",bk:{},today:9};
const repo=n=>new IndexedDbPmsRepository({indexedDBImpl:indexedDB,databaseName:"pms-test-"+n,now:()=>"2026-11-07T00:00:00Z"});
const event=(n,id="f1")=>({eventId:"event-"+n,tenantId:"t1",propertyId:"p1",deviceId:"d1",entityType:"folio",entityId:id,sequence:n,schemaVersion:1,eventType:"FOLIO_UPDATED",occurredAt:"2026-11-07T00:00:00Z",payload:{amountPaise:100}});
test("legacy parser validates required shape and retains exact source",()=>{const raw=JSON.stringify(state),s=parseLegacyPmsSnapshot(raw);assert.equal(s.raw,raw);assert.equal(s.parsed.today,9);assert.throws(()=>parseLegacyPmsSnapshot("{"));assert.throws(()=>parseLegacyPmsSnapshot(JSON.stringify({b:[]})));});
test("business entity and outbox event share atomic transaction",async()=>{const r=repo("atomic");await assert.rejects(r.transactBusinessChange({entityType:"folio",entityId:"f1",expectedVersion:0,event:event(1)},()=>{throw Error("crash");}));assert.equal(await r.getEntity("folio","f1"),null);assert.deepEqual(await r.claimOutboxBatch({deviceId:"d1"}),[]);await r.transactBusinessChange({entityType:"folio",entityId:"f1",expectedVersion:0,event:event(1)},()=>({balancePaise:100}));assert.equal((await r.claimOutboxBatch({deviceId:"d1"})).length,1);});
test("asynchronous mutation callbacks are rejected before IndexedDB can auto-close the transaction",async()=>{const r=repo("async-callback");await assert.rejects(r.transactBusinessChange({entityType:"folio",entityId:"f1",expectedVersion:0,event:event(1)},async()=>({v:1})),/must be synchronous/);assert.equal(await r.getEntity("folio","f1"),null);assert.deepEqual(await r.claimOutboxBatch({deviceId:"d1"}),[]);});
test("stale entity versions fail without adding outbox events",async()=>{const r=repo("stale");await r.transactBusinessChange({entityType:"folio",entityId:"f1",expectedVersion:0,event:event(1)},()=>({v:1}));await assert.rejects(r.transactBusinessChange({entityType:"folio",entityId:"f1",expectedVersion:0,event:event(1)},()=>({v:2})),e=>e.code==="ENTITY_VERSION_CONFLICT");assert.equal((await r.claimOutboxBatch({deviceId:"d1"})).length,1);});
test("acknowledgements are lease, device and sequence bound",async()=>{const r=repo("ack");await r.transactBusinessChange({entityType:"folio",entityId:"f1",expectedVersion:0,event:event(1)},()=>({v:1}));await r.claimOutboxBatch({deviceId:"d1"});await assert.rejects(r.acknowledgeOutbox({deviceId:"d2",acknowledgements:[{eventId:"event-1",sequence:1}]}));await assert.rejects(r.acknowledgeOutbox({deviceId:"d1",acknowledgements:[{eventId:"event-1",sequence:2}]}));assert.deepEqual(await r.acknowledgeOutbox({deviceId:"d1",acknowledgements:[{eventId:"event-1",sequence:1}]}),{acknowledged:1});});
test("legacy migration is atomic, one-time and retains exact raw backup",async()=>{const r=repo("migration"),raw=JSON.stringify(state),snap=parseLegacyPmsSnapshot(raw);const a=await r.migrateLegacySnapshot(snap,{migrationId:"mig1",sourceKey:"aurelia-state"});assert.equal(a.entityCount,Object.keys(state).length);assert.deepEqual((await r.getEntity("legacy","b")).data,[]);assert.equal((await r.readMigrationSnapshot("mig1")).raw,raw);assert.deepEqual(await r.migrateLegacySnapshot(snap,{migrationId:"mig1",sourceKey:"aurelia-state"}),{alreadyMigrated:true,migrationId:"mig1"});await assert.rejects(r.migrateLegacySnapshot(snap,{migrationId:"mig2",sourceKey:"aurelia-state"}),/marker already exists/);});
test("migration refuses a non-empty canonical store",async()=>{const r=repo("nonempty");await r.transactBusinessChange({entityType:"folio",entityId:"f1",expectedVersion:0,event:event(1)},()=>({v:1}));await assert.rejects(r.migrateLegacySnapshot(parseLegacyPmsSnapshot(JSON.stringify(state)),{migrationId:"mig1",sourceKey:"aurelia-state"}),/not empty/);});
test("retry scheduling is enforced and conflict transitions remain lease protected",async()=>{const r=repo("delivery");await r.transactBusinessChange({entityType:"folio",entityId:"f1",expectedVersion:0,event:event(1)},()=>({v:1}));await r.claimOutboxBatch({deviceId:"d1"});assert.equal(await r.retryOutbox({deviceId:"d1",eventId:"event-1",retryAt:"2999-11-07T00:01:00Z",errorCode:"NETWORK"}),true);assert.deepEqual(await r.claimOutboxBatch({deviceId:"d1"}),[]);const r2=repo("conflict");await r2.transactBusinessChange({entityType:"folio",entityId:"f1",expectedVersion:0,event:event(1)},()=>({v:1}));await r2.claimOutboxBatch({deviceId:"d1"});assert.equal(await r2.markOutboxConflict({deviceId:"d1",eventId:"event-1",conflictCode:"VERSION_CONFLICT"}),true);});


const sharedContract=JSON.parse(fs.readFileSync(path.join(process.cwd(),"tests/fixtures/pms-repository-contract.json"),"utf8"));
const contractEvent=(type,id,sequence,eventId)=>({eventId,tenantId:"tenant-contract",propertyId:"property-contract",deviceId:"device-contract",entityType:type,entityId:id,sequence,schemaVersion:1,eventType:"contract.updated",occurredAt:sharedContract.timestamps.createdAt,payload:{amountMinor:sharedContract.entity.data.amountMinor,currency:"INR"}});
test("shared repository contract: CRUD, optimistic conflicts, deterministic ordering and integer minor units",async()=>{
 const r=repo("shared-contract-crud"),f=sharedContract.entity;
 assert.equal(Number.isSafeInteger(f.data.amountMinor),true);
 assert.match(f.data.createdAt,/Z$/);
 await r.transactBusinessChange({entityType:f.type,entityId:f.id,expectedVersion:0,event:contractEvent(f.type,f.id,1,"contract-booking-event-1")},()=>f.data);
 const stored=await r.getEntity(f.type,f.id);assert.equal(stored.version,1);assert.deepEqual(stored.data,f.data);
 await r.transactBusinessChange({entityType:f.type,entityId:f.id,expectedVersion:1,event:contractEvent(f.type,f.id,2,"contract-booking-event-2")},()=>sharedContract.update);
 await assert.rejects(r.transactBusinessChange({entityType:f.type,entityId:f.id,expectedVersion:1,event:contractEvent(f.type,f.id,2,"contract-booking-event-stale")},()=>f.data),e=>e.code==="ENTITY_VERSION_CONFLICT");
 const ids=["contract-booking-z","contract-booking-a"];
 for(let i=0;i<ids.length;i++)await r.transactBusinessChange({entityType:"booking",entityId:ids[i],expectedVersion:0,event:contractEvent("booking",ids[i],1,"contract-order-"+i)},()=>({id:ids[i],amountMinor:0,currency:"INR"}));
 const listed=await r.listEntities("booking");const ordered=listed.map(x=>x.id);
 assert.deepEqual(ordered,[...ordered].sort((a,b)=>a.localeCompare(b)));
});
test("shared repository contract: atomic multi-entity writes, outbox retry and repository re-open",async()=>{
 const r=repo("shared-contract-restart");
 const changes=sharedContract.batch.map((row,i)=>({entityType:row.type,entityId:row.id,expectedVersion:0,data:row.data,event:contractEvent(row.type,row.id,1,"contract-batch-event-"+i)}));
 const committed=await r.transactBusinessBatch(changes);assert.equal(committed.length,2);
 const retryId=sharedContract.outbox.retryEventId;
 await r.transactBusinessChange({entityType:"folio",entityId:"contract-retry-folio",expectedVersion:0,event:contractEvent("folio","contract-retry-folio",1,retryId)},()=>({id:"contract-retry-folio",balanceMinor:100,currency:"INR"}));
 const claimed=await r.claimOutboxBatch({deviceId:sharedContract.outbox.deviceId});assert.ok(claimed.some(x=>x.eventId===retryId));
 await r.retryOutbox({deviceId:sharedContract.outbox.deviceId,eventId:retryId,retryAt:sharedContract.outbox.retryAt,errorCode:"NETWORK"});
 const reopened=repo("shared-contract-restart");
 assert.equal((await reopened.getEntity("folio","contract-retry-folio")).version,1);
 assert.equal((await reopened.claimOutboxBatch({deviceId:sharedContract.outbox.deviceId})).some(x=>x.eventId===retryId),false);
});

test("repository rejects non-UTC event timestamps at the IndexedDB boundary",async()=>{
 const r=repo("utc-boundary");
 const invalid={...event(1,"utc-folio"),occurredAt:"2026-11-09T17:30:00.000+05:30"};
 await assert.rejects(r.transactBusinessChange({entityType:"folio",entityId:"utc-folio",expectedVersion:0,event:invalid},()=>({balanceMinor:1})),/UTC ISO timestamp/);
 assert.equal(await r.getEntity("folio","utc-folio"),null);
});
