import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

test("all inline JavaScript in index.html parses before packaging", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  assert.ok(scripts.length > 0, "index.html must contain inline scripts");

  let checked = 0;
  for (const [index, match] of scripts.entries()) {
    const attrs = match[1] || "";
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = attrs.match(/\btype\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (type && !["text/javascript", "application/javascript", "module"].includes(type)) continue;

    const inputType = type === "module" ? "module" : "commonjs";
    const result = spawnSync(process.execPath, ["--check", "--input-type=" + inputType], {
      input: match[2],
      encoding: "utf8"
    });
    assert.equal(
      result.status,
      0,
      "Inline script " + (index + 1) + " failed syntax parsing:\n" + (result.stderr || result.stdout)
    );
    checked++;
  }
  assert.ok(checked > 0, "at least one inline JavaScript block must be syntax-checked");
});
