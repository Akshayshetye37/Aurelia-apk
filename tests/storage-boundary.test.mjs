// Ratchet: direct legacy/browser storage use outside src/storage may only shrink.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BANNED = /\b(?:localStorage|sessionStorage|indexedDB|IDBDatabase)\b|aurelia_lodge_v2/g;
const baseline = JSON.parse(fs.readFileSync(new URL("./storage-baseline.json", import.meta.url), "utf8"));
const sourceExtensions = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".html", ".vue", ".svelte"]);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(absolute);
    return entry.isFile() && sourceExtensions.has(path.extname(entry.name)) ? [absolute] : [];
  });
}
function sourceFiles() {
  return [path.join(ROOT, "index.html"), ...walk(path.join(ROOT, "src"))]
    .filter(file => fs.existsSync(file))
    .filter(file => !path.relative(ROOT, file).split(path.sep).join("/").startsWith("src/storage/"));
}
function countHits(source) { return (source.match(BANNED) || []).length; }

test("direct browser storage access outside src/storage never grows beyond the audited baseline", () => {
  const observed = new Map();
  for (const file of sourceFiles()) {
    const relative = path.relative(ROOT, file).split(path.sep).join("/");
    observed.set(relative, countHits(fs.readFileSync(file, "utf8")));
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    assert.ok(observed.has(file), `baseline source file disappeared without an explicit baseline review: ${file}`);
    assert.ok(observed.get(file) <= allowed, `${file}: ${observed.get(file)} direct storage hits exceed baseline ${allowed}`);
  }
  for (const [file, hits] of observed) {
    assert.ok(hits <= (baseline[file] ?? 0), `${file}: new direct storage bypass detected (${hits} hits)`);
  }
});


test("guest photo persistence never falls back to localStorage and migrates legacy copies only after read-back", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.doesNotMatch(html, /localStorage\\.setItem\\(PHOTO_FALLBACK_PREFIX/);
  assert.doesNotMatch(html, /localStorage\\.getItem\\(PHOTO_FALLBACK_PREFIX/);
  assert.match(html, /migrateLegacyPhotoFallback/);
  assert.match(html, /Restored photo archive failed exact read-back verification/);
  assert.match(html, /Legacy photo migration read-back mismatch/);
  assert.match(html, /localStorage\\.removeItem\\(PHOTO_FALLBACK_PREFIX/);
});
