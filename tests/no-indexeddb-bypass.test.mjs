import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const root=process.cwd(),src=path.join(root,"src");
const extensions=new Set([".js",".mjs",".cjs",".ts",".tsx",".jsx"]);
function walk(dir,files=[]){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory()){if(path.relative(root,full).split(path.sep).join("/")!=="src/storage")walk(full,files);}else if(extensions.has(path.extname(entry.name)))files.push(full);}return files;}
test("IndexedDB, Dexie and Web Storage globals are confined to src/storage",()=>{const violations=[];for(const file of walk(src)){const relative=path.relative(root,file).split(path.sep).join("/");if(relative.startsWith("src/storage/"))continue;const source=fs.readFileSync(file,"utf8");for(const [pattern,label] of [[/\\bindexedDB\\b/g,"indexedDB"],[/\\bIDBDatabase\\b/g,"IDBDatabase"],[/\\bdexie\\b/gi,"dexie"],[/\\blocalStorage\\b/g,"localStorage"]])if(pattern.test(source))violations.push(relative+":"+label);}const html=fs.readFileSync(path.join(root,"index.html"),"utf8");for(const [pattern,label] of [[/\\bindexedDB\\b/g,"indexedDB"],[/\\bIDBDatabase\\b/g,"IDBDatabase"],[/\\bdexie\\b/gi,"dexie"],[/\\blocalStorage\\b/g,"localStorage"]])if(pattern.test(html))violations.push("index.html:"+label);assert.deepEqual(violations,[],"Storage API bypasses found outside src/storage: "+violations.join(", "));});
