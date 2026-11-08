import test from "node:test";import assert from "node:assert/strict";import{indexedDB}from"fake-indexeddb";import{IndexedDbPmsRepository,parseLegacyPmsSnapshot}from"../src/storage/indexeddb-pms-repository.mjs";
const state={rooms:[],b:[],g:[],t:[],exp:[],inv:[],led:[],aud:[],set:{name:"Aurelia"},menu:{},tab:"home",bk:{},today:9};
const repo=n=>new IndexedDbPmsRepository({indexedDBImpl:indexedDB,databaseName:"pms-test-"+n,now:()=>"2026-11-07T00:00:00Z"});
const event=(n,id="f1")=>({eventId:"event-"+n,tenantId:"t1",propertyId:"p1",deviceId:"d1",entityType:"folio",entityId:id,sequence:n,schemaVersion:1,eventType:"FOLIO_UPDATED",occurredAt:"2026-11-07T00:00:00Z",payload:{amountPaise:100}});
test("legacy parser validates required shape and retains exact source",()=>{const raw=JSON.stringify(state),s=parseLegacyPmsSnapshot(raw);assert.equal(s.raw,raw);assert.equal(s.parsed.today,9);assert.throws(()=>parseLegacyPmsSnapshot("{"));assert.throws(()=>parseLegacyPmsSnapshot(JSON.stringify({b:[]})));});
test("business entity and outbox event share atomic transaction",async()=>{const r=repo("atomic");await assert.rejects(r.transactBusinessChange({entityType:"folio",entityId:"f1",expectedVersion:0,event:event(1)},()=>{throw Error("crash");}));assert.equal(await r.getEntity("folio","f1"),null);assert.deepEqual(await r.claimOutboxBatch({deviceId:"d1"}),[]);await r.transactBusinessChange({entityType:"folio",entityId:"f1",expectedVersion:0,event:event(1)},()=>({balancePaise:100}));assert.equal((await r.claimOutboxBatch({deviceId:"d1"})).length,1);});
test("stale entity versions fail without adding outbox events",async()=>{const r=repo("stale");await r.transactBusinessChange({entityType:"folio",entityId:"f1",expectedVersion:0,event:event(1)},()=>({v:1}));await assert.rejects(r.transactBusinessChange({entityType:"folio",entityId:"f1",expectedVersion:0,event:event(1)},()=>({v:2})),e=>e.code==="ENTITY_VERSION_CONFLICT");assert.equal((await r.claimOutboxBatch({deviceId:"d1"})).length,1);});
test("acknowledgements are lease, device and sequence bound",async()=>{const r=repo("ack");await r.transactBusinessChange({entityType:"folio",entityId:"f1",expectedVersion:0,event:event(1)},()=>({v:1}));await r.claimOutboxBatch({deviceId:"d1"});await assert.rejects(r.acknowledgeOutbox({deviceId:"d2",acknowledgements:[{eventId:"event-1",sequence:1}]}));await assert.rejects(r.acknowledgeOutbox({deviceId:"d1",acknowledgements:[{eventId:"event-1",sequence:2}]}));assert.deepEqual(await r.acknowledgeOutbox({deviceId:"d1",acknowledgements:[{eventId:"event-1",sequence:1}]}),{acknowledged:1});});
test("legacy migration is atomic, one-time and retains exact raw backup",async()=>{const r=repo("migration"),raw=JSON.stringify(state),snap=parseLegacyPmsSnapshot(raw);const a=await r.migrateLegacySnapshot(snap,{migrationId:"mig1",sourceKey:"aurelia-state"});assert.equal(a.entityCount,Object.keys(state).length);assert.deepEqual((await r.getEntity("legacy","b")).data,[]);assert.equal((await r.readMigrationSnapshot("mig1")).raw,raw);const db=await r.database(),tx=db.transaction("legacy_backup","readonly"),backup=await new Promise((resolve,reject)=>{const q=tx.objectStore("legacy_backup").get("mig1");q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});assert.equal(backup.raw,raw);assert.deepEqual(await r.migrateLegacySnapshot(snap,{migrationId:"mig1",sourceKey:"aurelia-state"}),{alreadyMigrated:true,migrationId:"mig1"});await assert.rejects(r.migrateLegacySnapshot(snap,{migrationId:"mig2",sourceKey:"aurelia-state"}),/marker already exists/);});
test("migration refuses a non-empty canonical store",async()=>{const r=repo("nonempty");await r.transactBusinessChange({entityType:"folio",entityId:"f1",expectedVersion:0,event:event(1)},()=>({v:1}));await assert.rejects(r.migrateLegacySnapshot(parseLegacyPmsSnapshot(JSON.stringify(state)),{migrationId:"mig1",sourceKey:"aurelia-state"}),/not empty/);});
test("retry scheduling is enforced and conflict transitions remain lease protected",async()=>{const r=repo("delivery");await r.transactBusinessChange({entityType:"folio",entityId:"f1",expectedVersion:0,event:event(1)},()=>({v:1}));await r.claimOutboxBatch({deviceId:"d1"});assert.equal(await r.retryOutbox({deviceId:"d1",eventId:"event-1",retryAt:"2999-11-07T00:01:00Z",errorCode:"NETWORK"}),true);assert.deepEqual(await r.claimOutboxBatch({deviceId:"d1"}),[]);const r2=repo("conflict");await r2.transactBusinessChange({entityType:"folio",entityId:"f1",expectedVersion:0,event:event(1)},()=>({v:1}));await r2.claimOutboxBatch({deviceId:"d1"});assert.equal(await r2.markOutboxConflict({deviceId:"d1",eventId:"event-1",conflictCode:"VERSION_CONFLICT"}),true);});

test("expired outbox leases cannot be acknowledged or transitioned and can be reclaimed",async()=>{const r=repo("expired-lease");await r.transactBusinessChange({entityType:"folio",entityId:"f1",expectedVersion:0,event:event(1)},()=>({v:1}));await r.claimOutboxBatch({deviceId:"d1",leaseMs:1000});const db=await r.database();const tx=db.transaction("outbox","readwrite"),store=tx.objectStore("outbox"),row=await new Promise((resolve,reject)=>{const q=store.get("event-1");q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});row.leaseUntil=new Date(Date.now()-1000).toISOString();store.put(row);await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});await assert.rejects(r.acknowledgeOutbox({deviceId:"d1",acknowledgements:[{eventId:"event-1",sequence:1}]}),/unexpired active lease/);await assert.rejects(r.retryOutbox({deviceId:"d1",eventId:"event-1",retryAt:"2999-11-07T00:01:00Z",errorCode:"NETWORK"}),/unexpired lease/);const reclaimed=await r.claimOutboxBatch({deviceId:"d2"});assert.equal(reclaimed.length,1);assert.equal(reclaimed[0].leaseOwner,"d2");assert.deepEqual(await r.acknowledgeOutbox({deviceId:"d2",acknowledgements:[{eventId:"event-1",sequence:1}]}),{acknowledged:1});});
test("outbox lease duration is bounded by the repository contract",async()=>{const r=repo("lease-bounds");await assert.rejects(r.claimOutboxBatch({deviceId:"d1",leaseMs:999}),/Lease must be 1000/);await assert.rejects(r.claimOutboxBatch({deviceId:"d1",leaseMs:3600001}),/Lease must be 1000/);});

test("multi-entity business batch commits all records and outbox events together",async()=>{
 const r=repo("batch-atomic");
 const roomEvent={...event(1,"room-1"),entityType:"room",entityId:"room-1",eventId:"event-room-1",eventType:"room.assignment_changed"};
 const bookingEvent={...event(1,"booking-1"),entityType:"booking",entityId:"booking-1",eventId:"event-booking-1",eventType:"booking.room_reassigned"};
 const rows=await r.transactBusinessBatch([
  {entityType:"room",entityId:"room-1",expectedVersion:0,data:{id:"room-1",occupied:true},event:roomEvent},
  {entityType:"booking",entityId:"booking-1",expectedVersion:0,data:{id:"booking-1",roomId:"room-1"},event:bookingEvent}
 ]);
 assert.deepEqual(rows.map(x=>x.version),[1,1]);
 assert.equal((await r.getEntity("room","room-1")).data.occupied,true);
 assert.equal((await r.getEntity("booking","booking-1")).data.roomId,"room-1");
 assert.equal((await r.claimOutboxBatch({deviceId:"d1"})).length,2);
});
test("multi-entity batch rolls back every entity and event when any version is stale",async()=>{
 const r=repo("batch-rollback");
 await r.transactBusinessChange({entityType:"booking",entityId:"booking-1",expectedVersion:0,event:{...event(1,"booking-1"),entityType:"booking",entityId:"booking-1",eventId:"seed-booking"}},()=>({roomId:"room-old"}));
 const before=await r.getEntity("booking","booking-1");
 const roomEvent={...event(1,"room-1"),entityType:"room",entityId:"room-1",eventId:"batch-room"};
 const bookingEvent={...event(1,"booking-1"),entityType:"booking",entityId:"booking-1",eventId:"batch-booking"};
 await assert.rejects(r.transactBusinessBatch([
  {entityType:"room",entityId:"room-1",expectedVersion:0,data:{id:"room-1"},event:roomEvent},
  {entityType:"booking",entityId:"booking-1",expectedVersion:0,data:{roomId:"room-new"},event:bookingEvent}
 ]),e=>e.code==="ENTITY_VERSION_CONFLICT");
 assert.equal(await r.getEntity("room","room-1"),null);
 assert.deepEqual(await r.getEntity("booking","booking-1"),before);
 assert.equal((await r.claimOutboxBatch({deviceId:"d1"})).length,1);
});
test("multi-entity batch rejects duplicate entity keys before writing",async()=>{
 const r=repo("batch-duplicate");
 const ev1={...event(1,"room-1"),entityType:"room",entityId:"room-1",eventId:"dup-1"};
 const ev2={...event(1,"room-1"),entityType:"room",entityId:"room-1",eventId:"dup-2"};
 await assert.rejects(r.transactBusinessBatch([
  {entityType:"room",entityId:"room-1",expectedVersion:0,data:{},event:ev1},
  {entityType:"room",entityId:"room-1",expectedVersion:0,data:{},event:ev2}
 ]),/Duplicate entity/);
 assert.equal(await r.getEntity("room","room-1"),null);
});


test("schema v1 to v3 migration snapshots every existing store before advancing schema version",async()=>{
 const name="pms-schema-upgrade-backup";
 const opened=await new Promise((resolve,reject)=>{
  const request=indexedDB.open(name,1);
  request.onupgradeneeded=()=>{
   const db=request.result;
   db.createObjectStore("meta",{keyPath:"key"});
   db.createObjectStore("entities",{keyPath:"key"}).createIndex("type","type");
   const outbox=db.createObjectStore("outbox",{keyPath:"eventId"});
   outbox.createIndex("status","status");
   outbox.createIndex("sequenceKey","sequenceKey",{unique:true});
   db.createObjectStore("migration_snapshots",{keyPath:"id"});
  };
  request.onsuccess=()=>resolve(request.result);
  request.onerror=()=>reject(request.error);
 });
 const seed=opened.transaction(["meta","entities","outbox","migration_snapshots"],"readwrite");
 seed.objectStore("meta").put({key:"legacy-marker",migrationId:"mig-v1"});
 seed.objectStore("entities").put({key:"room:101",type:"room",id:"101",version:1,data:{id:"101"},updatedAt:"2026-11-07T00:00:00Z"});
 seed.objectStore("outbox").put({eventId:"evt-v1",sequenceKey:"room:101:0000000000000001",status:"PENDING",payload:{v:1}});
 seed.objectStore("migration_snapshots").put({id:"mig-v1",raw:"{}"});
 await new Promise((resolve,reject)=>{seed.oncomplete=resolve;seed.onerror=()=>reject(seed.error);seed.onabort=()=>reject(seed.error);});
 opened.close();
 const upgraded=new IndexedDbPmsRepository({indexedDBImpl:indexedDB,databaseName:name});
 const db=await upgraded.database();
 assert.equal(db.version,3);
 assert.deepEqual((await upgraded.getEntity("room","101")).data,{id:"101"});
 const tx=db.transaction(["meta","migration_backups"],"readonly");
 const meta=await new Promise((resolve,reject)=>{const q=tx.objectStore("meta").get("schema-version");q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
 const backups=await new Promise((resolve,reject)=>{const q=tx.objectStore("migration_backups").getAll();q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
 await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});
 assert.equal(meta.version,3);
 assert.equal(backups.length,4);
 assert.ok(backups.some(row=>row.sourceStore==="entities"&&row.sourceKey==="room:101"&&row.value.data.id==="101"));
 assert.ok(backups.some(row=>row.sourceStore==="outbox"&&row.sourceKey==="evt-v1"));
 assert.ok(backups.some(row=>row.sourceStore==="migration_snapshots"&&row.sourceKey==="mig-v1"));
});
