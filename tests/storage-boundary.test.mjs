import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const forbidden=new RegExp(["indexedDB","IDBDatabase","localStorage","dexie"].join("|"));
function violations(source){return source.split(/\r?\n/).flatMap((line,index)=>forbidden.test(line)?[index+1+": "+line.trim().slice(0,180)]:[])}
async function scan(dir){const out=[];for(const entry of await readdir(dir,{withFileTypes:true})){if([".git","node_modules","dist","coverage","android","www"].includes(entry.name))continue;const full=path.join(dir,entry.name);if(entry.isDirectory()){if(full===path.join(root,"src","storage"))continue;out.push(...await scan(full));}else if(/\.(?:m?js|html|ts|tsx)$/.test(entry.name))out.push(full);}return out;}
test("storage boundary detector rejects a direct IndexedDB bypass",()=>{assert.notDeepEqual(violations("const db = indexedDB.open('business');"),[]);assert.notDeepEqual(violations("window.localStorage.setItem('x','y');"),[]);});
test("browser database and Web Storage APIs are private to src/storage",async()=>{const hits=[];for(const file of await scan(path.join(root,"src"))){const source=await readFile(file,"utf8");for(const line of violations(source))hits.push(path.relative(root,file)+":"+line);}const html=await readFile(path.join(root,"index.html"),"utf8");for(const line of violations(html))hits.push("index.html:"+line);assert.deepEqual(hits,[],"Move direct browser storage/database access behind src/storage repositories.\\n"+hits.join("\\n"));});
