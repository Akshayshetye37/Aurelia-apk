import test from "node:test";
import assert from "node:assert/strict";
import { installPreferenceStorageGuard, PREFERENCE_STORAGE_KEYS } from "../src/storage/preference-storage-guard.mjs";

function fakeStorage() {
  const values = new Map();
  return { values, setItem(key,value){values.set(String(key),String(value));}, getItem(key){return values.get(String(key))??null;} };
}

test("preference guard permits only explicit UI preference keys",()=>{
 const storage=fakeStorage(),guard=installPreferenceStorageGuard({storage,mode:"test"});
 assert.throws(()=>PREFERENCE_STORAGE_KEYS.push("payment_status"),TypeError);
 storage.setItem("theme","dark");storage.setItem("lang","en");
 assert.equal(storage.getItem("theme"),"dark");
 assert.throws(()=>storage.setItem(["aurelia","lodge","v2"].join("_"),"{}"),error=>error.name==="StorageAuthorityViolation");
 assert.throws(()=>storage.setItem("payment_status","PAID"),error=>error.name==="StorageAuthorityViolation");
 guard.restore();
 storage.setItem("business-test","ok");
 assert.equal(storage.getItem("business-test"),"ok");
});

test("production preference guard logs and ignores non-preference writes",()=>{
 const storage=fakeStorage(),logged=[];
 installPreferenceStorageGuard({storage,mode:"production",logger:{error:(...args)=>logged.push(args)}});
 storage.setItem("inventory","[]");
 assert.equal(storage.getItem("inventory"),null);
 assert.equal(logged.length,1);
 storage.setItem("theme","light");
 assert.equal(storage.getItem("theme"),"light");
});
