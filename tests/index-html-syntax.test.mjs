import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("classic inline application scripts parse without executing", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0, "index.html must contain inline application scripts");
  let checked = 0;
  for (const match of scripts) {
    const attrs = match[1] || "";
    if (/\bsrc\s*=|\btype\s*=\s*["']module["']/i.test(attrs)) continue;
    const type = attrs.match(/\btype\s*=\s*["']([^"']+)["']/i)?.[1];
    if (type && !/^(text|application)\/(javascript|ecmascript)$/i.test(type)) continue;
    const code = match[2] || "";
    if (!code.trim()) continue;
    assert.doesNotThrow(() => new Function(code), "inline script " + (attrs.match(/\bid=["']([^"']+)/i)?.[1] || checked) + " must parse");
    checked++;
  }
  assert.ok(checked >= 10, "expected to validate the PMS inline script set");
});
