const PHOTO_DB = "aurelia_photo_archive_v1";

function isSandboxedPreview() {
  try {
    return String(globalThis.location?.href || "").startsWith("about:srcdoc") ||
      !!(globalThis.window?.frameElement &&
        globalThis.window.frameElement.hasAttribute("sandbox") &&
        !globalThis.window.frameElement.sandbox.contains("allow-same-origin"));
  } catch {
    return String(globalThis.location?.href || "").startsWith("about:srcdoc");
  }
}

export function createPhotoArchive({
  indexedDBImpl = globalThis.indexedDB,
  nativeWindow = globalThis.window,
  readLegacyPhotoFallbackEntries = () => [],
  deleteLegacyPhotoFallbackEntries = () => {},
  sandboxed = isSandboxedPreview
} = {}) {
  const memoryFallback = new Map();
  const pendingNative = new Map();
  let nativeSequence = 0;
  let legacyMigration = null;

  if (nativeWindow) {
    nativeWindow.aureliaNativePhotoResult = (id, ok, payload) => {
      const pending = pendingNative.get(String(id));
      if (!pending) return;
      pendingNative.delete(String(id));
      if (ok) {
        if (pending.type === "photoArchive" && typeof payload === "string") {
          try { payload = JSON.parse(payload); }
          catch (error) { pending.reject(error); return; }
        }
        pending.resolve(payload);
      } else {
        pending.reject(new Error(payload || "Native photo storage failed"));
      }
    };
  }

  function native(type, extra = {}) {
    return new Promise((resolve, reject) => {
      if (!nativeWindow?.AureliaNative || typeof nativeWindow.nat !== "function") {
        reject(new Error("Native photo storage is only available in the Android app"));
        return;
      }
      const requestId = "photo-" + Date.now() + "-" + (++nativeSequence);
      pendingNative.set(requestId, { resolve, reject, type });
      if (!nativeWindow.nat({ type, requestId, ...extra })) {
        pendingNative.delete(requestId);
        reject(new Error("Could not contact native photo storage"));
        return;
      }
      setTimeout(() => {
        const pending = pendingNative.get(requestId);
        if (pending) {
          pendingNative.delete(requestId);
          pending.reject(new Error("Native photo storage timed out"));
        }
      }, 30000);
    });
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      try {
        if (!indexedDBImpl || typeof indexedDBImpl.open !== "function") throw new Error("IndexedDB unavailable");
        const request = indexedDBImpl.open(PHOTO_DB, 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains("originals")) request.result.createObjectStore("originals");
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Photo storage unavailable"));
      } catch (error) { reject(error); }
    });
  }

  async function migrateLegacyPhotos(database) {
    if (sandboxed()) return;
    const entries = readLegacyPhotoFallbackEntries();
    if (!Array.isArray(entries) || entries.length === 0) return;
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("originals", "readwrite");
      const store = transaction.objectStore("originals");
      entries.forEach(([key, value]) => store.put(value, key));
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("Legacy photo migration failed"));
      transaction.onabort = () => reject(transaction.error || new Error("Legacy photo migration was aborted"));
    });
    for (const [key, value] of entries) {
      const stored = await new Promise((resolve, reject) => {
        const transaction = database.transaction("originals", "readonly");
        const request = transaction.objectStore("originals").get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Legacy photo read-back failed"));
      });
      if (stored !== value) throw new Error("Legacy photo migration read-back mismatch; source photo was retained.");
    }
    deleteLegacyPhotoFallbackEntries(entries);
  }

  async function database() {
    const db = await openDatabase();
    if (!legacyMigration) {
      legacyMigration = migrateLegacyPhotos(db).catch(error => {
        legacyMigration = null;
        throw error;
      });
    }
    try { await legacyMigration; return db; }
    catch (error) { db.close(); throw error; }
  }

  async function put(key, data) {
    if (nativeWindow?.AureliaNative) return native("photoStore", { key, data }).then(() => true);
    if (sandboxed()) { memoryFallback.set(key, data); return true; }
    let db;
    try {
      db = await database();
      await new Promise((resolve, reject) => {
        const transaction = db.transaction("originals", "readwrite");
        transaction.objectStore("originals").put(data, key);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error("Could not store original photo"));
        transaction.onabort = () => reject(transaction.error || new Error("Photo storage transaction aborted"));
      });
      return true;
    } catch (error) {
      throw new Error("Durable photo storage is unavailable; no volatile fallback was written. " + (error?.message || ""));
    } finally { db?.close(); }
  }

  async function get(key) {
    if (!key) return null;
    if (nativeWindow?.AureliaNative) return native("photoLoad", { key }).catch(() => null);
    if (memoryFallback.has(key)) return memoryFallback.get(key);
    if (sandboxed()) return null;
    const db = await database();
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction("originals").objectStore("originals").get(key);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error("Could not read original photo"));
      });
    } finally { db.close(); }
  }

  async function archive() {
    if (nativeWindow?.AureliaNative) return native("photoArchive");
    if (sandboxed()) {
      const memory = {};
      memoryFallback.forEach((value, key) => { memory[key] = value; });
      return memory;
    }
    const output = {};
    const db = await database();
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction("originals", "readonly");
        const keys = transaction.objectStore("originals").getAllKeys();
        const values = transaction.objectStore("originals").getAll();
        transaction.oncomplete = () => {
          keys.result.forEach((key, index) => { output[key] = values.result[index]; });
          resolve();
        };
        transaction.onerror = () => reject(transaction.error || new Error("Could not prepare photo archive"));
        transaction.onabort = () => reject(transaction.error || new Error("Photo archive read was aborted"));
      });
      return output;
    } finally { db.close(); }
  }

  async function restore(archive) {
    if (!archive || typeof archive !== "object" || Array.isArray(archive)) throw new Error("Backup photo archive is invalid");
    const entries = Object.entries(archive);
    for (const [key, value] of entries) {
      if (!key || typeof value !== "string" || !/^data:image\//i.test(value)) throw new Error("Photo archive contains an invalid original image");
    }
    if (nativeWindow?.AureliaNative) {
      await native("photoRestore", { archive });
      return entries.length;
    }
    if (sandboxed()) {
      memoryFallback.clear();
      for (const [key, value] of entries) memoryFallback.set(key, value);
      return entries.length;
    }
    const db = await database();
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction("originals", "readwrite");
        const store = transaction.objectStore("originals");
        store.clear();
        entries.forEach(([key, value]) => store.put(value, key));
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error("Could not restore original photos"));
        transaction.onabort = () => reject(transaction.error || new Error("Photo restore was cancelled"));
      });
      const stored = await Promise.all(entries.map(([key]) => new Promise((resolve, reject) => {
        const transaction = db.transaction("originals", "readonly");
        const request = transaction.objectStore("originals").get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Restored photo read-back failed"));
      })));
      if (entries.some((entry, index) => stored[index] !== entry[1])) {
        throw new Error("Restored photo archive failed exact read-back verification");
      }
    } finally { db.close(); }
    memoryFallback.clear();
    return entries.length;
  }

  return Object.freeze({ put, get, archive, restore });
}
