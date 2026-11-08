import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const start = html.indexOf('<script id="aurelia-safe-storage">');
const end = html.indexOf("</script>", start);
assert.ok(start >= 0 && end > start, "safe storage adapter must exist");
const adapter = html.slice(start, end);

test("localStorage quota or security errors must propagate instead of falling back to volatile memory", () => {
  const setStart = adapter.indexOf("setItem: function(k,v){");
  const setEnd = adapter.indexOf("removeItem: function", setStart);
  assert.ok(setStart >= 0 && setEnd > setStart, "storage setItem adapter must exist");
  const setter = adapter.slice(setStart, setEnd);
  assert.match(setter, /if\(ok\)\{/);
  assert.match(setter, /localStorage\.setItem\(k,String\(v\)\)/);
  assert.match(setter, /throw new Error\('Device storage write failed:/);
  assert.ok(setter.indexOf("throw new Error") < setter.indexOf("mem[k]=String(v)"), "volatile fallback is allowed only when durable storage was unavailable at startup");
});

test("strict accounting persistence cannot write outside the canonical asynchronous repository", () => {
  const p = html.indexOf("function persistStrict(){");
  const q = html.indexOf("\nlet LOCAL_STATE_STATUS", p);
  assert.ok(p >= 0 && q > p);
  const strict = html.slice(p, q);
  assert.match(strict, /Synchronous accounting persistence is disabled/);
  assert.equal(strict.includes("localStorage"), false);
  assert.equal(strict.includes("setItem(SK"), false);
});
