const DB = "aurelia-local-identity";
const STORE = "identity";
const KEY = "primary";

function create(cryptoImpl = globalThis.crypto, now = () => new Date().toISOString()) {
  if (!cryptoImpl || typeof cryptoImpl.randomUUID !== "function") {
    throw new Error("Cryptographically secure UUID generation is required");
  }
  const installationId = "ins_" + cryptoImpl.randomUUID();
  return Object.freeze({
    schemaVersion: 1,
    installationId,
    tenantId: "local_" + installationId,
    propertyId: "property_" + cryptoImpl.randomUUID(),
    deviceId: "device_" + cryptoImpl.randomUUID(),
    createdAt: now(),
    scope: "LOCAL_ONLY"
  });
}

export function validateLocalIdentity(value) {
  if (!value || value.schemaVersion !== 1 || value.scope !== "LOCAL_ONLY") {
    throw Object.assign(new Error("Stored local identity schema is invalid"), { code: "LOCAL_IDENTITY_INVALID" });
  }
  for (const field of ["installationId", "tenantId", "propertyId", "deviceId"]) {
    if (typeof value[field] !== "string" || value[field].length < 16 || value[field].length > 120) {
      throw Object.assign(new Error("Stored local identity failed validation: " + field), { code: "LOCAL_IDENTITY_INVALID" });
    }
  }
  if (value.tenantId !== "local_" + value.installationId || !Number.isFinite(Date.parse(value.createdAt))) {
    throw Object.assign(new Error("Stored local identity scope/timestamp is invalid"), { code: "LOCAL_IDENTITY_INVALID" });
  }
  return Object.freeze({ ...value });
}

export async function getOrCreateBrowserLocalIdentity({
  indexedDBImpl = globalThis.indexedDB,
  cryptoImpl = globalThis.crypto,
  now = () => new Date().toISOString(),
  databaseName = DB
} = {}) {
  if (!indexedDBImpl || typeof indexedDBImpl.open !== "function") {
    throw Object.assign(new Error("Durable IndexedDB local identity storage is unavailable; Web Storage fallback is prohibited."), {
      code: "LOCAL_IDENTITY_STORAGE_UNAVAILABLE"
    });
  }
  let db;
  try {
    db = await new Promise((resolve, reject) => {
      const request = indexedDBImpl.open(databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open local identity database."));
      request.onblocked = () => reject(new Error("Local identity database upgrade is blocked."));
    });
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      const request = store.get(KEY);
      let identity;
      request.onsuccess = () => {
        try {
          identity = request.result ? validateLocalIdentity(request.result) : create(cryptoImpl, now);
          if (!request.result) store.add(identity, KEY);
        } catch (error) {
          try { transaction.abort(); } catch {}
          reject(error);
        }
      };
      request.onerror = () => {
        try { transaction.abort(); } catch {}
        reject(request.error || new Error("Could not read local identity."));
      };
      transaction.oncomplete = () => resolve(identity);
      transaction.onerror = () => reject(transaction.error || new Error("Local identity transaction failed."));
      transaction.onabort = () => reject(transaction.error || new Error("Local identity transaction aborted."));
    });
  } catch (error) {
    if (error?.code === "LOCAL_IDENTITY_INVALID") throw error;
    throw Object.assign(new Error("Durable IndexedDB local identity storage failed; refusing to create a replacement identity. " + (error?.message || "")), {
      code: "LOCAL_IDENTITY_STORAGE_FAILED",
      cause: error
    });
  } finally {
    db?.close();
  }
}
