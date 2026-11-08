import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const forbidden=/\\b(?:indexedDB|IDBDatabase|localStorage|dexie)\\b/;
async function files(dir){const out=[];for(const entry of await readdir(dir,{withFileTypes:true})){if([".git","node_modules","dist","coverage","android","www"].includes(entry.name))continue;const full=path.join(dir,entry.name);if(entry.isDirectory()){if(full===path.join(root,"src","storage"))continue;out.push(...await files(full));}else if(/\\.(?:m?js|html|ts|tsx)$/.test(entry.name))out.push(full);}return out;}
test("browser database and Web Storage APIs are private to src/storage",async()=>{const violations=[];for(const file of await files(root)){const source=await readFile(file,"utf8");const lines=source.split(/\\r?\\n/);lines.forEach((line,index)=>{if(forbidden.test(line))violations.push(path.relative(root,file)+":"+(index+1)+": "+line.trim().slice(0,180));});}assert.deepEqual(violations,[],"Move all direct browser storage/database access behind src/storage repositories.\\n"+violations.join("\\n"));});
