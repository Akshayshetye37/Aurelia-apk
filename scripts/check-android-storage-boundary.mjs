import fs from "node:fs";
import path from "node:path";
const root=process.cwd(),storage=path.join(root,"www","src","storage");
for(const name of ["indexeddb-pms-repository.mjs","indexeddb-storage-adapter.mjs"]){if(fs.existsSync(path.join(storage,name)))throw new Error("Android web bundle must exclude IndexedDB business adapter: "+name);}
for(const name of ["capacitor-pms-storage.mjs","legacy-snapshot-parser.mjs","pms-bootstrap-coordinator.mjs","sqlite-storage-adapter.mjs","storage-adapter.mjs"]){if(!fs.existsSync(path.join(storage,name)))throw new Error("Android web bundle is missing required SQLite storage module: "+name);}
const coordinator=fs.readFileSync(path.join(storage,"pms-bootstrap-coordinator.mjs"),"utf8");if(!coordinator.includes('await import("./indexeddb-pms-repository.mjs")'))throw new Error("Browser IndexedDB repository must be loaded only through the browser branch");
console.log("Android storage boundary verified: SQLite adapter present; IndexedDB business adapter excluded.");
