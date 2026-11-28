import test from "node:test";
import assert from "node:assert/strict";
import { BaseRepo } from "../src/storage/pms-base-repository.mjs";

function bridge() {
  const rows=new Map();
  return {
    async fetchEntity(type,id){const row=rows.get(type+":"+id);return row?structuredClone(row):null;},
    async listEntities(type){return [...rows.values()].filter(row=>row.type===type).map(row=>structuredClone(row));},
    async mutateEntity(input){
      const key=input.entityType+":"+input.entityId,old=rows.get(key),version=old?.version||0;
      if(version!==input.expectedVersion)throw Object.assign(new Error("version conflict"),{code:"ENTITY_VERSION_CONFLICT",actualVersion:version});
      const data=old?structuredClone(old.data):{id:input.entityId};
      input.mutate(data);
      const row={type:input.entityType,id:input.entityId,version:version+1,data};
      rows.set(key,row);return {entity:structuredClone(row)};
    }
  };
}

test("BaseRepo enforces optimistic versions and stable entity identity",async()=>{
  const repo=new BaseRepo({bridge:bridge(),entityType:"guest"});
  const created=await repo.create("guest-1",{name:"Guest One"});
  assert.equal(created.version,1);
  assert.equal((await repo.get("guest-1")).data.name,"Guest One");
  const updated=await repo.update("guest-1",1,current=>({...current,name:"Guest Two"}));
  assert.equal(updated.version,2);
  assert.equal(updated.data.name,"Guest Two");
  await assert.rejects(repo.update("guest-1",1,current=>({...current,name:"stale"})),e=>e.code==="ENTITY_VERSION_CONFLICT");
});

test("BaseRepo keeps immutable ledger and audit entities append-only",async()=>{
  const repo=new BaseRepo({bridge:bridge(),entityType:"ledger"});
  await assert.rejects(repo.update("line-1",1,current=>current),e=>e.code==="PMS_ENTITY_IMMUTABLE");
  await assert.rejects(repo.retire("line-1",1),e=>e.code==="PMS_ENTITY_IMMUTABLE");
});
