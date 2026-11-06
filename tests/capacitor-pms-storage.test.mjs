import test from "node:test";
import assert from "node:assert/strict";
import { CapacitorPmsStorageClient } from "../src/storage/capacitor-pms-storage.mjs";

function fakePlugin() {
  const calls=[], entities=new Map(), outbox=new Map(), snapshots=new Map(), migrations=new Map();
  let failNextMigration=false;
  const key=(type,id)=>type+":"+id;
  const clone=x=>x==null?x:structuredClone(x);
  return {
    calls, entities, outbox, snapshots,
    failMigrationOnce(){failNextMigration=true;},
    async initializeStorage(){calls.push("initializeStorage");return{success:true,engine:"android-sqlite",contractVersion:1};},
    async getEntity({entityType,entityId}){calls.push("getEntity");return{entity:clone(entities.get(key(entityType,entityId))||null)};},
    async listEntities({entityType}){calls.push("listEntities");return{entities:[...entities.values()].filter(x=>x.type===entityType).map(clone)};},
    async transactBusinessChange(args){
      calls.push("transactBusinessChange");const k=key(args.entityType,args.entityId),old=entities.get(k),actual=old?.version??0;
      if(actual!==args.expectedVersion){const e=new Error("ENTITY_VERSION_CONFLICT");e.code="ENTITY_VERSION_CONFLICT";throw e;}
      if(args.event.entityType!==args.entityType||args.event.entityId!==args.entityId||args.event.sequence!==actual+1)throw new Error("pms_event_sequence_mismatch");
      if(outbox.has(args.event.eventId))throw new Error("duplicate event");
      const row={key:k,type:args.entityType,id:args.entityId,version:actual+1,data:clone(args.data),updatedAt:new Date().toISOString()};
      entities.set(k,row);outbox.set(args.event.eventId,{...clone(args.event),status:"PENDING",attempts:0,createdAt:new Date().toISOString(),leaseOwner:null,leaseUntil:null});
      return{entityType:args.entityType,entityId:args.entityId,version:row.version,data:row.data};
    },
    async migrateLegacySnapshot(args){
      calls.push("migrateLegacySnapshot");
      if(failNextMigration){failNextMigration=false;throw new Error("simulated process interruption before commit");}
      const prior=migrations.get("legacy-localstorage");
      if(prior){if(prior.migrationId!==args.migrationId||prior.sourceKey!==args.sourceKey||snapshots.get(args.migrationId).raw!==args.raw)throw new Error("legacy_migration_replay_payload_mismatch");return{alreadyMigrated:true,migrationId:args.migrationId,entityCount:prior.entityCount};}
      if(entities.size)throw new Error("canonical_repository_not_empty");
      const parsed=JSON.parse(args.raw),rows=Object.entries(parsed).map(([id,data])=>({key:"legacy:"+id,type:"legacy",id,version:1,data:clone(data),updatedAt:new Date().toISOString()}));
      const snap={id:args.migrationId,sourceKey:args.sourceKey,raw:args.raw,sourceTimestamp:args.sourceTimestamp,importedAt:new Date().toISOString(),formatVersion:1};
      rows.forEach(x=>entities.set(key("legacy",x.id),x));snapshots.set(args.migrationId,snap);migrations.set("legacy-localstorage",{migrationId:args.migrationId,sourceKey:args.sourceKey,entityCount:rows.length});
      return{alreadyMigrated:false,migrationId:args.migrationId,entityCount:rows.length};
    },
    async readMigrationSnapshot({migrationId}){return{snapshot:clone(snapshots.get(migrationId)||null)};},
    async claimOutboxBatch({deviceId,limit,leaseMs}){
      calls.push("claimOutboxBatch");const now=Date.now(),eligible=[...outbox.values()].filter(x=>x.status==="PENDING"||(x.status==="RETRY"&&(!x.retryAt||Date.parse(x.retryAt)<=now))||(x.status==="IN_FLIGHT"&&Date.parse(x.leaseUntil)<=now)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.sequence-b.sequence).slice(0,limit);
      for(const x of eligible){x.status="IN_FLIGHT";x.leaseOwner=deviceId;x.leaseUntil=new Date(now+leaseMs).toISOString();x.attempts++;}
      return{events:clone(eligible)};
    },
    async acknowledgeOutbox({deviceId,acknowledgements}){
      calls.push("acknowledgeOutbox");const pending=acknowledgements.map(a=>outbox.get(a.eventId));
      if(pending.some((x,i)=>!x||x.status!=="IN_FLIGHT"||x.leaseOwner!==deviceId||x.sequence!==acknowledgements[i].sequence))throw new Error("OUTBOX_LEASE_MISMATCH");
      pending.forEach(x=>{x.status="ACKNOWLEDGED";x.leaseOwner=null;x.leaseUntil=null;x.acknowledgedAt=new Date().toISOString();});
      return{acknowledged:pending.length};
    },
    async retryOutbox({deviceId,eventId,retryAt,errorCode}){const x=outbox.get(eventId);if(!x||x.status!=="IN_FLIGHT"||x.leaseOwner!==deviceId)throw new Error("OUTBOX_LEASE_MISMATCH");Object.assign(x,{status:"RETRY",retryAt,errorCode,lastErrorCode:errorCode,leaseOwner:null,leaseUntil:null});return{success:true};},
    async markOutboxConflict({deviceId,eventId,conflictCode}){const x=outbox.get(eventId);if(!x||x.status!=="IN_FLIGHT"||x.leaseOwner!==deviceId)throw new Error("OUTBOX_LEASE_MISMATCH");Object.assign(x,{status:"CONFLICT",lastErrorCode:conflictCode,leaseOwner:null,leaseUntil:null});return{success:true};}
  };
}
const event=(id,entityType="booking",entityId="b-1",sequence=1)=>({eventId:id,tenantId:"tenant-1",propertyId:"property-1",deviceId:"device-1",entityType,entityId,sequence,eventType:"entity.updated",schemaVersion:1,occurredAt:new Date().toISOString(),payload:{status:"reserved"}});

test("native adapter requires explicit contract-version initialization",async()=>{
 const p=fakePlugin(),r=new CapacitorPmsStorageClient(p);assert.equal((await r.initializeStorage()).contractVersion,1);
});
test("native adapter lists entity rows and commits entity plus outbox in one native transaction",async()=>{
 const p=fakePlugin(),r=new CapacitorPmsStorageClient(p);const saved=await r.transactBusinessChange({entityType:"booking",entityId:"b-1",expectedVersion:0,event:event("e-1")},()=>({status:"reserved"}));
 assert.equal(saved.version,1);assert.equal((await r.listEntities("booking")).length,1);assert.equal(p.outbox.get("e-1").status,"PENDING");
});
test("native adapter rejects stale versions and async mutation callbacks",async()=>{
 const p=fakePlugin(),r=new CapacitorPmsStorageClient(p);await r.transactBusinessChange({entityType:"folio",entityId:"f-1",expectedVersion:0,event:event("f-e1","folio","f-1")},()=>({balance:500}));
 await assert.rejects(r.transactBusinessChange({entityType:"folio",entityId:"f-1",expectedVersion:0,event:event("f-e2","folio","f-1")},()=>({balance:0})),e=>e.code==="ENTITY_VERSION_CONFLICT");
 await assert.rejects(r.transactBusinessChange({entityType:"folio",entityId:"f-2",expectedVersion:0,event:event("f-e3","folio","f-2")},async()=>({balance:0})),/must be synchronous/);
});
test("legacy import is atomic, exact, read-back verifiable and idempotent",async()=>{
 const p=fakePlugin(),r=new CapacitorPmsStorageClient(p),raw=JSON.stringify({rooms:[{id:"r1"}],b:[],g:[],t:[],exp:[],inv:[],led:[],aud:[],set:{},menu:{}});
 const snapshot={raw,parsed:JSON.parse(raw)},args={migrationId:"migration-1",sourceKey:"aurelia_lodge_v2",sourceTimestamp:"2026-11-07T00:00:00.000Z"};
 assert.equal((await r.migrateLegacySnapshot(snapshot,args)).alreadyMigrated,false);
 const read=await r.readMigrationSnapshot("migration-1");assert.equal(read.raw,raw);assert.equal(read.sourceKey,args.sourceKey);assert.equal((await r.listEntities("legacy")).length,10);
 assert.equal((await r.migrateLegacySnapshot(snapshot,args)).alreadyMigrated,true);
 await assert.rejects(r.migrateLegacySnapshot({raw:raw+" "},args),/replay_payload_mismatch/);
});
test("interrupted migration leaves no partial import and can be replayed after restart",async()=>{
 const p=fakePlugin(),r=new CapacitorPmsStorageClient(p),raw=JSON.stringify({rooms:[],b:[],g:[],t:[],exp:[],inv:[],led:[],aud:[],set:{},menu:{}}),args={migrationId:"recover-1",sourceKey:"aurelia_lodge_v2"};
 p.failMigrationOnce();await assert.rejects(r.migrateLegacySnapshot({raw},args),/interruption/);assert.equal((await r.listEntities("legacy")).length,0);
 assert.equal((await r.migrateLegacySnapshot({raw},args)).alreadyMigrated,false);assert.equal((await r.listEntities("legacy")).length,10);
});
test("outbox lease, acknowledgement, retry schedule and conflict lifecycle enforce lease ownership",async()=>{
 const p=fakePlugin(),r=new CapacitorPmsStorageClient(p);await r.transactBusinessChange({entityType:"booking",entityId:"b-1",expectedVersion:0,event:event("out-1")},()=>({status:"reserved"}));
 let batch=await r.claimOutboxBatch({deviceId:"device-1"});assert.equal(batch.length,1);assert.equal(batch[0].status,"IN_FLIGHT");
 await assert.rejects(r.acknowledgeOutbox({deviceId:"wrong-device",acknowledgements:[{eventId:"out-1",sequence:1}]}),/LEASE_MISMATCH/);
 await r.retryOutbox({deviceId:"device-1",eventId:"out-1",retryAt:new Date(Date.now()+60000).toISOString(),errorCode:"NETWORK"});
 assert.equal((await r.claimOutboxBatch({deviceId:"device-1"})).length,0);
 p.outbox.get("out-1").retryAt=new Date(Date.now()-1000).toISOString();batch=await r.claimOutboxBatch({deviceId:"device-1"});assert.equal(batch.length,1);
 await r.acknowledgeOutbox({deviceId:"device-1",acknowledgements:[{eventId:"out-1",sequence:1}]});assert.equal(p.outbox.get("out-1").status,"ACKNOWLEDGED");
 await r.transactBusinessChange({entityType:"booking",entityId:"b-1",expectedVersion:1,event:event("out-2","booking","b-1",2)},()=>({status:"cancelled"}));
 batch=await r.claimOutboxBatch({deviceId:"device-1"});await r.markOutboxConflict({deviceId:"device-1",eventId:"out-2",conflictCode:"VERSION_CONFLICT"});assert.equal(p.outbox.get("out-2").status,"CONFLICT");
});
