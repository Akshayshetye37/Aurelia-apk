// Ratchet: direct legacy/browser storage use outside src/storage may only shrink.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BANNED = /\b(?:localStorage|sessionStorage|indexedDB|IDBDatabase)\b|aurelia_lodge_v2/g;
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
    .filter(file => path.relative(ROOT, file).split(path.sep).join("/") !== "src/storage/legacy-web-storage.mjs");
}
function countHits(source) { return (source.match(BANNED) || []).length; }

test("direct browser storage APIs and the legacy business key are confined to src/storage", () => {
  const violations = [];
  for (const file of sourceFiles()) {
    const relative = path.relative(ROOT, file).split(path.sep).join("/");
    const source = fs.readFileSync(file, "utf8");
    const inStorageAdapterLayer = relative.startsWith("src/storage/");
    const hits = inStorageAdapterLayer
      ? (source.match(/\\b(?:localStorage|sessionStorage)\\b/g) || []).length
      : countHits(source);
    if (hits > 0) violations.push(relative + ": " + hits + " forbidden storage reference(s)");
  }
  assert.deepEqual(violations, [], "Move all browser storage access and legacy business-key references into src/storage.");
});


test("the sole legacy Web Storage adapter enforces migration and preference key allowlists", () => {
  const adapter = fs.readFileSync(path.join(ROOT, "src/storage/legacy-web-storage.mjs"), "utf8");
  assert.match(adapter, /ALLOWED_MIGRATION_KEYS = new Set\(\[LEGACY_STATE_KEY, MIGRATION_STATUS_KEY\]\)/);
  assert.match(adapter, /ALLOWED_PREFERENCE_KEYS = new Set\(\["theme", "lang"\]\)/);
  assert.match(adapter, /LEGACY_STORAGE_KEY_NOT_ALLOWED/);
  assert.match(adapter, /PREFERENCE_STORAGE_KEY_NOT_ALLOWED/);
});

test("guest photo persistence stays inside the storage adapter and migrates legacy copies only after read-back", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const photo = fs.readFileSync(path.join(ROOT, "src/storage/photo-archive.mjs"), "utf8");
  assert.match(html, /AureliaPhotoArchive/);
  assert.match(html, /AureliaBackupVaultStore/);
  assert.doesNotMatch(html, /localStorage|sessionStorage|indexedDB|IDBDatabase/);
  assert.match(photo, /migrateLegacyPhotos/);
  assert.match(photo, /Restored photo archive failed exact read-back verification/);
  assert.match(photo, /Legacy photo migration read-back mismatch/);
  assert.match(photo, /deleteLegacyPhotoFallbackEntries\(entries\)/);
});


test("local-first write coordinator never writes the legacy Web Storage business cache", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/storage/pms-local-first-write-coordinator.mjs"), "utf8");
  assert.doesNotMatch(source, /(?:localStorage|sessionStorage|\.setItem\s*\(|aurelia_lodge_v2|cacheKey)/);
});
