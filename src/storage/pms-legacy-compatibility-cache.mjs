/** Compatibility-only bridge for the legacy PMS snapshot cache.
 * Canonical repository transactions remain authoritative; this adapter is
 * intentionally isolated in the storage boundary and is not a business store.
 */
export const LEGACY_PMS_SNAPSHOT_KEY = "aurelia_lodge_v2";
export const LEGACY_PMS_SNAPSHOT_ENTITY_ID = "legacy_snapshot:" + LEGACY_PMS_SNAPSHOT_KEY;

export function getLegacyCompatibilityStorage() {
  return globalThis.window?.__aureliaStorage || globalThis.localStorage || null;
}

export function refreshLegacyCompatibilityCache(storage, snapshot) {
  if (!storage) return null;
  try {
    if (storage.memoryOnly === true) return false;
    const serialized = JSON.stringify(snapshot);
    storage.setItem(LEGACY_PMS_SNAPSHOT_KEY, serialized);
    return storage.getItem(LEGACY_PMS_SNAPSHOT_KEY) === serialized;
  } catch (error) {
    console.warn("[Aurelia Local Cache] Canonical state committed; compatibility cache refresh failed.", error);
    return false;
  }
}
