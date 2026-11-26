import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const start = html.indexOf("function restoreF(el){");
const end = html.indexOf("function normaliseImportedBooking", start);
assert.ok(start >= 0 && end > start, "backup restore parser must exist");
const restore = html.slice(start, end);

test("backup restore rejects oversized files before reading or parsing them", () => {
  assert.match(restore, /MAX_BACKUP_BYTES=50\*1024\*1024/);
  assert.match(restore, /f\.size>MAX_BACKUP_BYTES/);
  assert.match(restore, /new TextEncoder\(\)\.encode\(t\)\.byteLength>MAX_BACKUP_BYTES/);
});

test("backup restore enforces per-collection and aggregate record ceilings", () => {
  assert.match(restore, /rooms:5000,bookings:100000,guests:100000,expenses:100000,inventory:20000/);
  assert.match(restore, /rows\.length>limit/);
  assert.match(restore, /totalRows>200000/);
  assert.ok(restore.indexOf("importLimits=") < restore.indexOf("S.rst=normal"), "limits must run before records are staged");
});
