/**
 * Web Storage compatibility adapter. Kept inside src/storage so application
 * screens never access browser key-value storage directly.
 */
import { installPreferenceStorageGuard } from "./preference-storage-guard.mjs";

const DETECTED_BUILD_MODE = globalThis.__AURELIA_BUILD_MODE ||
  (import.meta.env?.DEV ? "development" : import.meta.env?.MODE) ||
  (typeof process !== "undefined" && process.env?.NODE_ENV) ||
  (typeof process !== "undefined" && process.argv?.includes("--test") ? "test" : "production");

export class StorageFullError extends Error {
  constructor(message = "Device storage is full. Export your PMS data and free space before continuing.", options = {}) {
    super(message, options);
    this.name = "StorageFullError";
    this.code = "STORAGE_FULL";
    this.action = "EXPORT_DATA";
  }
}

export function createWebStorageAdapter({
  windowRef = globalThis.window,
  storage = windowRef?.localStorage,
  mode = DETECTED_BUILD_MODE
} = {}) {
  const memory = new Map();
  const durableSetItem = storage?.setItem?.bind(storage);
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
  if (persistent) installPreferenceStorageGuard({ storage, mode });
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
        try { durableSetItem(String(key), String(value)); return; }
        catch (error) {
          const failure = new Error("Device storage write failed: " + (error?.name || "StorageError"));
          if (error?.name === "QuotaExceededError") throw new StorageFullError(undefined, { cause: error });
          failure.name = "StorageWriteError";
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
