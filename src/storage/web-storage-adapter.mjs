/**
 * Web Storage compatibility adapter. Kept inside src/storage so application
 * screens never access browser key-value storage directly.
 */
export function createWebStorageAdapter({
  windowRef = globalThis.window,
  storage = windowRef?.localStorage
} = {}) {
  const memory = new Map();
  let initializationError = null;
  let persistent = false;
  try {
    if (!storage || typeof storage.getItem !== "function" ||
        typeof storage.setItem !== "function" ||
        typeof storage.removeItem !== "function") {
      throw new Error("Web Storage is unavailable");
    }
    const probe = "__aurelia_storage_probe__";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    persistent = true;
  } catch (error) {
    initializationError = error;
  }
  let embeddedPreview = false;
  try {
    embeddedPreview = String(windowRef?.location?.href || "").startsWith("about:srcdoc") ||
      Boolean(windowRef?.frameElement?.hasAttribute?.("sandbox") &&
        !windowRef.frameElement.sandbox.contains("allow-same-origin"));
  } catch {
    embeddedPreview = String(windowRef?.location?.href || "").startsWith("about:srcdoc");
  }
  const adapter = {
    getItem(key) {
      if (persistent) {
        try { return storage.getItem(String(key)); } catch {}
      }
      return memory.has(String(key)) ? memory.get(String(key)) : null;
    },
    setItem(key, value) {
      if (persistent) {
        try { storage.setItem(String(key), String(value)); return; }
        catch (error) {
          const failure = new Error("Device storage write failed: " + (error?.name || "StorageError"));
          failure.name = error?.name === "QuotaExceededError" ? "QuotaExceededError" : "StorageWriteError";
          throw failure;
        }
      }
      memory.set(String(key), String(value));
    },
    removeItem(key) {
      if (persistent) {
        try { storage.removeItem(String(key)); } catch {}
      }
      memory.delete(String(key));
    },
    get memoryOnly() { return !persistent; },
    get memoryOnlyReason() { return !persistent ? (embeddedPreview ? "embedded-preview-sandbox" : (initializationError?.name || "storage-unavailable")) : null; },
    get persistent() { return persistent; }
  };
  if (windowRef) {
    windowRef.__aureliaStorage = adapter;
    windowRef.AureliaStorageDiagnostics = Object.freeze({
      persistent,
      mode: persistent ? "browser-local-storage" : "session-memory-only",
      reason: !persistent ? (embeddedPreview
        ? "The embedded HTML preview uses an opaque sandbox origin and blocks durable browser storage."
        : (initializationError?.message || "Browser storage is unavailable.")) : null,
      embeddedPreview
    });
  }
  return adapter;
}
