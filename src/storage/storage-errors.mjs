// Typed storage failures shared by IndexedDB and native SQLite adapters.
export class StorageFullError extends Error {
  constructor(cause) {
    super("Device storage is full; the change was NOT saved. Free device space before retrying.");
    this.name = "StorageFullError";
    this.code = "STORAGE_FULL";
    if (cause) this.cause = cause;
  }
}
export function isStorageFull(error) {
  if (!error) return false;
  if (error instanceof StorageFullError) return true;
  return error.name === "QuotaExceededError" || error.code === 22 || error.code === 1014 ||
    error.code === "PMS_STORAGE_FULL" || error.code === "STORAGE_FULL" ||
    /quota|disk is full|database or disk is full/i.test(String(error.message || ""));
}
export const mapStorageError = error =>
  error instanceof StorageFullError ? error : isStorageFull(error) ? new StorageFullError(error) : error;
export function guardNativePlugin(plugin) {
  if (!plugin || typeof plugin !== "object") return plugin;
  return new Proxy(plugin, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      return async (...args) => {
        try { return await value.apply(target, args); }
        catch (error) { throw mapStorageError(error); }
      };
    }
  });
}
