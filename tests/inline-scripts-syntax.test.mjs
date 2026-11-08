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


test('UPI payment intent never sends guest or payment metadata to a third-party QR endpoint', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /api\.qrserver\.com/);
  assert.ok(html.includes('upi://pay?'));
  assert.match(html, /Open UPI app/);
  assert.match(html, /QR display is temporarily disabled/);
});


test("cancellation accounting waits for canonical snapshot commit and verifies the committed snapshot, not the Web Storage cache", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const start = html.indexOf("window.commitCancellationRefund=async function(i){");
  assert.notEqual(start, -1, "cancellation accounting handler must be async");
  const end = html.indexOf("\n};", start);
  assert.notEqual(end, -1, "cancellation accounting handler must be closed");
  const handler = html.slice(start, end);
  assert.match(handler, /const saved=await persistCanonicalStrict\(\)/);
  assert.match(handler, /const savedBooking=saved&&Array\.isArray\(saved\.cancelled\)/);
  assert.doesNotMatch(handler, /__aureliaStorage|localStorage/);
  assert.match(handler, /await persistCanonicalStrict\(\)/);
  assert.match(handler, /RECOVERY_CHECK_PENDING=true/);
  const strictStart = html.indexOf("async function persistCanonicalStrict(){");
  const strictEnd = html.indexOf("\n}", strictStart);
  assert.notEqual(strictStart, -1);
  assert.notEqual(strictEnd, -1);
  const strictWriter = html.slice(strictStart, strictEnd);
  assert.match(strictWriter, /AureliaLocalOperationalLock/);
  assert.match(strictWriter, /await coordinator\.save\(state\)/);
});
