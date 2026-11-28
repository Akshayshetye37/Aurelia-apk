import test from "node:test";
import assert from "node:assert/strict";
import { PmsRepositoryBridge } from "../src/storage/pms-repository-bridge.mjs";

test("bridge binds a transactional repository and returns versioned entities", async () => {
  const rows = new Map();
  const repository = {
    async getEntity(type,id) { const row=rows.get(type+":"+id); return row ? structuredClone(row) : null; },
    async listEntities(type) { return [...rows.values()].filter(row=>row.type===type).map(row=>structuredClone(row)); },
    async transactBusinessChange(input,apply) {
      const key=input.entityType+":"+input.entityId, old=rows.get(key), version=old?.version||0;
      if(version!==input.expectedVersion) throw Object.assign(new Error("version conflict"),{code:"ENTITY_VERSION_CONFLICT"});
      const data=apply({data:old?.data||null,version});
      const row={type:input.entityType,id:input.entityId,version:version+1,data:structuredClone(data),event:structuredClone(input.event)};
      rows.set(key,row); return structuredClone(row);
    },
    async transactBusinessBatch(changes) {
      const committed=[];
      for(const change of changes) {
        const key=change.entityType+":"+change.entityId, old=rows.get(key), version=old?.version||0;
        if(version!==change.expectedVersion) throw Object.assign(new Error("version conflict"),{code:"ENTITY_VERSION_CONFLICT"});
      }
      for(const change of changes) {
        const key=change.entityType+":"+change.entityId, version=change.expectedVersion+1;
        const row={type:change.entityType,id:change.entityId,version,data:structuredClone(change.data),event:structuredClone(change.event)};
        rows.set(key,row); committed.push(structuredClone(row));
      }
      return committed;
    }
  };
  const bridge=new PmsRepositoryBridge({
    tenantId:"tenant-local",propertyId:"property-local",deviceId:"device-local",
    eventId:(()=>{let n=0;return()=> "evt-"+(++n)})()
  }).bindActiveEngine(repository);
  const created=await bridge.mutateEntity({
    entityType:"guest",entityId:"guest-1",expectedVersion:0,eventType:"guest.created",
    mutate:data=>{data.name="Guest One";return data;}
  });
  assert.equal(created.entity.version,1);
  assert.equal((await bridge.fetchEntity("guest","guest-1")).data.name,"Guest One");
  assert.equal((await bridge.listEntities("guest")).length,1);
  assert.equal(rows.get("guest:guest-1").event.sequence,1);
});

test("bridge rejects asynchronous mutation callbacks before committing", async () => {
  const repository={getEntity:async()=>null,transactBusinessChange:async(input,apply)=>apply({data:null,version:0}),transactBusinessBatch:async()=>[]};
  const bridge=new PmsRepositoryBridge({tenantId:"t",propertyId:"p",deviceId:"d",eventId:()=>"evt-1"}).bindActiveEngine(repository);
  await assert.rejects(bridge.mutateEntity({
    entityType:"guest",entityId:"guest-2",expectedVersion:0,eventType:"guest.created",
    mutate:async data=>{data.name="Async";return data;}
  }),/synchronous/);
});
