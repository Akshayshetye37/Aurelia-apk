const LEGACY_STATE_KEY = "aurelia_lodge_v2";
const MIGRATION_STATUS_KEY = "aurelia_canonical_migration_status";
const PHOTO_FALLBACK_PREFIX = "aurelia_photo_fallback:";
const ALLOWED_MIGRATION_KEYS = new Set([LEGACY_STATE_KEY, MIGRATION_STATUS_KEY]);

function resolveStorage(storage) {
  if (storage !== undefined) return storage;
  try { return globalThis.localStorage; } catch { return null; }
}

export function createLegacyMigrationStorage({ storage } = {}) {
  const target = resolveStorage(storage);
  let persistent = false;
  let failure = null;
  const probe = "__aurelia_legacy_migration_probe__";
  try {
    if (!target || typeof target.getItem !== "function" ||
        typeof target.setItem !== "function" || typeof target.removeItem !== "function") {
      throw new Error("Browser Web Storage is unavailable");
    }
    target.setItem(probe, "1");
    if (target.getItem(probe) !== "1") throw new Error("Browser Web Storage probe read-back failed");
    target.removeItem(probe);
    persistent = true;
  } catch (error) {
    failure = error;
    try { target?.removeItem?.(probe); } catch {}
  }

  const assertAllowed = key => {
    if (!ALLOWED_MIGRATION_KEYS.has(key)) {
      throw Object.assign(new Error("Web Storage key is not allowed by the legacy migration adapter: " + String(key)), {
        code: "LEGACY_STORAGE_KEY_NOT_ALLOWED"
      });
    }
  };
  return Object.freeze({
    persistent,
    memoryOnly: !persistent,
    memoryOnlyReason: persistent ? null : String(failure?.message || "Browser Web Storage is unavailable"),
    getItem(key) {
      assertAllowed(key);
      if (!persistent) return null;
      return target.getItem(key);
    },
    setItem(key, value) {
      assertAllowed(key);
      if (!persistent) throw Object.assign(new Error("Legacy migration storage is unavailable; refusing a volatile write."), {
        code: "LEGACY_STORAGE_UNAVAILABLE"
      });
      const serialized = String(value);
      target.setItem(key, serialized);
      if (target.getItem(key) !== serialized) {
        throw Object.assign(new Error("Legacy migration value failed exact read-back verification."), {
          code: "LEGACY_STORAGE_READBACK_FAILED"
        });
      }
    },
    removeItem(key) {
      assertAllowed(key);
      if (!persistent) throw Object.assign(new Error("Legacy migration storage is unavailable."), {
        code: "LEGACY_STORAGE_UNAVAILABLE"
      });
      target.removeItem(key);
      if (target.getItem(key) !== null) {
        throw Object.assign(new Error("Legacy migration key removal failed exact read-back verification."), {
          code: "LEGACY_STORAGE_DELETE_FAILED"
        });
      }
    }
  });
}

export function readLegacyPhotoFallbackEntries({ storage } = {}) {
  const target = resolveStorage(storage);
  if (!target || typeof target.key !== "function" || typeof target.getItem !== "function") {
    throw Object.assign(new Error("Legacy photo storage is unavailable."), { code: "LEGACY_PHOTO_STORAGE_UNAVAILABLE" });
  }
  const entries = [];
  for (let index = 0; index < target.length; index += 1) {
    const key = target.key(index);
    if (typeof key !== "string" || !key.startsWith(PHOTO_FALLBACK_PREFIX)) continue;
    const value = target.getItem(key);
    if (typeof value === "string") entries.push([key.slice(PHOTO_FALLBACK_PREFIX.length), value]);
  }
  return entries;
}

export function deleteLegacyPhotoFallbackEntries(entries, { storage } = {}) {
  const target = resolveStorage(storage);
  if (!target || typeof target.getItem !== "function" || typeof target.removeItem !== "function" ||
      !Array.isArray(entries)) {
    throw Object.assign(new Error("Legacy photo deletion requires verified source entries and durable storage."), {
      code: "LEGACY_PHOTO_STORAGE_UNAVAILABLE"
    });
  }
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2 ||
        typeof entry[0] !== "string" || !entry[0] || typeof entry[1] !== "string") {
      throw new TypeError("Invalid legacy photo migration entry.");
    }
    const key = PHOTO_FALLBACK_PREFIX + entry[0];
    if (target.getItem(key) !== entry[1]) {
      throw Object.assign(new Error("Legacy photo source changed before verified deletion; source was retained."), {
        code: "LEGACY_PHOTO_SOURCE_CHANGED"
      });
    }
    target.removeItem(key);
    if (target.getItem(key) !== null) {
      throw Object.assign(new Error("Legacy photo source deletion failed read-back verification."), {
        code: "LEGACY_PHOTO_DELETE_FAILED"
      });
    }
  }
}
