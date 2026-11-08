/**
 * Narrow Web Storage boundary for user-interface preferences only.
 * Business state, backups, photos, and migration data belong in repositories.
 */
export const PREFERENCE_STORAGE_KEYS = Object.freeze([
  "theme", "lang", "language", "aurelia_theme", "aurelia_lang"
]);
const PREFERENCE_KEY_SET = new Set(PREFERENCE_STORAGE_KEYS);

export function installPreferenceStorageGuard({
  storage = globalThis.localStorage,
  mode = (typeof process !== "undefined" && process.env?.NODE_ENV) || "production",
  logger = console
} = {}) {
  if (!storage || typeof storage.setItem !== "function") throw new TypeError("A Storage-compatible object is required");
  const original = storage.setItem.bind(storage);
  const guarded = function(key, value) {
    const name = String(key);
    if (!PREFERENCE_KEY_SET.has(name)) {
      const error = new Error("Non-preference localStorage write rejected: " + name);
      error.name = "StorageAuthorityViolation";
      if (mode === "development" || mode === "test") throw error;
      logger?.error?.("[Aurelia storage] Ignored non-preference Web Storage write", { key: name });
      return;
    }
    return original(name, String(value));
  };
  storage.setItem = guarded;
  if (storage.setItem !== guarded) throw new Error("Web Storage implementation does not permit guard installation");
  return Object.freeze({ allowedKeys: PREFERENCE_STORAGE_KEYS, restore() { storage.setItem = original; } });
}
