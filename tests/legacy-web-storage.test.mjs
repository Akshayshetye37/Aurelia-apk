import test from "node:test";
import assert from "node:assert/strict";
import {
  createLegacyMigrationStorage,
  createPreferenceStorage,
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

test("preference Web Storage strictly permits only theme and lang", () => {
  const storage = makeStorage();
  const preferences = createPreferenceStorage({ storage });
  assert.equal(preferences.setItem("theme", "dark"), true);
  assert.equal(preferences.setItem("lang", "en"), true);
  assert.equal(preferences.getItem("theme"), "dark");
  assert.equal(preferences.getItem("lang"), "en");
  assert.throws(() => preferences.setItem("aurelia_lodge_v2", "{}"), error => error.code === "PREFERENCE_STORAGE_KEY_NOT_ALLOWED");
  assert.throws(() => preferences.getItem("backup-key"), error => error.code === "PREFERENCE_STORAGE_KEY_NOT_ALLOWED");
  assert.throws(() => preferences.removeItem("payment"), error => error.code === "PREFERENCE_STORAGE_KEY_NOT_ALLOWED");
});

test("production preference boundary logs and ignores non-preference keys", () => {
  const storage = makeStorage();
  const preferences = createPreferenceStorage({ storage, mode: "production" });
  assert.equal(preferences.setItem("business-state", "{}"), false);
  assert.equal(preferences.getItem("business-state"), null);
  assert.equal(preferences.removeItem("payment"), false);
  assert.equal(storage.values.size, 0);
});
