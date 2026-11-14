import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const start = html.indexOf("let id=0;const S=");
const end = html.indexOf("const MENU=", start);
assert.ok(start >= 0 && end > start, "initial PMS state must exist");
const initialState = html.slice(start, end);

test("fresh PMS installations start without fictitious guest, booking, room or restaurant records", () => {
  assert.match(initialState, /rooms:\[\],b:\[\],t:\[\],g:\[\],exp:\[\],inv:\[\]/);
  assert.match(initialState, /today:0,hist:\[0,0,0,0,0,0\]/);
  assert.doesNotMatch(initialState, /Mwila Chanda|Natasha Banda|Amara Okafor|Lubinda Mwiinga/);
  assert.doesNotMatch(initialState, /types\.forEach|S\.t=\[/);
});

test("fresh PMS installation has no seeded property inventory or booking fixture generator", () => {
  assert.doesNotMatch(initialState, /const types=/);
  assert.doesNotMatch(initialState, /const B=/);
  assert.doesNotMatch(initialState, /rooms\.push\(/);
});
