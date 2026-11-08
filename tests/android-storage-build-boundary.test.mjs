import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const root=process.cwd();
test("Android build prepares SQLite-only web assets and rejects IndexedDB business adapter",()=>{const build=spawnSync(process.execPath,["scripts/prepare-web.js","--android"],{cwd:root,encoding:"utf8"});assert.equal(build.status,0,build.stderr||build.stdout);const check=spawnSync(process.execPath,["scripts/check-android-storage-boundary.mjs"],{cwd:root,encoding:"utf8"});assert.equal(check.status,0,check.stderr||check.stdout);const storage=path.join(root,"www","src","storage");assert.equal(fs.existsSync(path.join(storage,"indexeddb-pms-repository.mjs")),false);assert.equal(fs.existsSync(path.join(storage,"indexeddb-storage-adapter.mjs")),false);assert.equal(fs.existsSync(path.join(storage,"capacitor-pms-storage.mjs")),true);});
