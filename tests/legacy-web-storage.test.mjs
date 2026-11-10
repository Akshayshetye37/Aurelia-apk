import test from "node:test";
import assert from "node:assert/strict";
import {
  createLegacyMigrationStorage,
  readLegacyPhotoFallbackEntries,
  deleteLegacyPhotoFallbackEntries
} from "../src/storage/legacy-web-storage.mjs";

function makeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    key(index) { return Array.from(values.keys())[index] ?? null; },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); },
    values
  };
}

test("legacy migration storage allows only the two migration keys and verifies writes", () => {
  const storage = makeStorage();
  const legacy = createLegacyMigrationStorage({ storage });
  assert.equal(legacy.persistent, true);
  legacy.setItem("aurelia_lodge_v2", '{"rooms":[]}');
  legacy.setItem("aurelia_canonical_migration_status", "VERIFIED:mig_legacy_12345678");
  assert.equal(legacy.getItem("aurelia_lodge_v2"), '{"rooms":[]}');
  assert.throws(() => legacy.getItem("theme"), error => error.code === "LEGACY_STORAGE_KEY_NOT_ALLOWED");
  assert.throws(() => legacy.setItem("aurelia_lodge_v2_recovery_quarantine", "x"), error => error.code === "LEGACY_STORAGE_KEY_NOT_ALLOWED");
  assert.throws(() => legacy.removeItem("aurelia_photo_fallback:one"), error => error.code === "LEGACY_STORAGE_KEY_NOT_ALLOWED");
});

test("legacy migration storage fails closed when durable Web Storage is unavailable", () => {
  const legacy = createLegacyMigrationStorage({ storage: null });
  assert.equal(legacy.persistent, false);
  assert.equal(legacy.memoryOnly, true);
  assert.equal(legacy.getItem("aurelia_lodge_v2"), null);
  assert.throws(() => legacy.setItem("aurelia_lodge_v2", "{}"), error => error.code === "LEGACY_STORAGE_UNAVAILABLE");
});

test("legacy photo fallback deletion requires exact IndexedDB read-back source bytes", () => {
  const storage = makeStorage({
    "aurelia_photo_fallback:photo-1": "data:image/png;base64,AA==",
    "theme": "dark"
  });
  const entries = readLegacyPhotoFallbackEntries({ storage });
  assert.deepEqual(entries, [["photo-1", "data:image/png;base64,AA=="]]);
  storage.setItem("aurelia_photo_fallback:photo-1", "changed");
  assert.throws(() => deleteLegacyPhotoFallbackEntries(entries, { storage }), error => error.code === "LEGACY_PHOTO_SOURCE_CHANGED");
  assert.equal(storage.getItem("aurelia_photo_fallback:photo-1"), "changed");
  storage.setItem("aurelia_photo_fallback:photo-1", entries[0][1]);
  deleteLegacyPhotoFallbackEntries(entries, { storage });
  assert.equal(storage.getItem("aurelia_photo_fallback:photo-1"), null);
  assert.equal(storage.getItem("theme"), "dark");
});
