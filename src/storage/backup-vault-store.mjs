const BACKUP_VAULT_DB = "aurelia-pms-backup-vault-v1";
const BACKUP_VAULT_ID = "primary";
const BACKUP_KDF_ITERATIONS = 600000;

function validBase64(value, expectedBytes) {
  return typeof value === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(value) &&
    value.length % 4 === 0 && value.length === Math.ceil(expectedBytes / 3) * 4 &&
    (expectedBytes % 3 === 0 || value.endsWith(expectedBytes % 3 === 1 ? "==" : "="));
}

function validCachedKey(key) {
  return key === undefined || (key && typeof key === "object" && key.type === "secret" &&
    key.algorithm?.name === "AES-GCM" && key.algorithm?.length === 256 && key.extractable === false &&
    Array.isArray(key.usages) && key.usages.includes("encrypt") && key.usages.includes("decrypt"));
}

function validRecord(record) {
  return !!record && record.id === BACKUP_VAULT_ID && record.format === 1 &&
    validBase64(record.wrappedKey, 48) && validBase64(record.salt, 16) &&
    validBase64(record.wrapIv, 12) && record.iterations === BACKUP_KDF_ITERATIONS &&
    validCachedKey(record.key);
}

export function createBackupVaultStore({ indexedDBImpl = globalThis.indexedDB } = {}) {
  async function open() {
    return new Promise((resolve, reject) => {
      try {
        if (!indexedDBImpl || typeof indexedDBImpl.open !== "function") throw new Error("IndexedDB unavailable");
        const request = indexedDBImpl.open(BACKUP_VAULT_DB, 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains("vault")) {
            request.result.createObjectStore("vault", { keyPath: "id" });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Could not open encrypted backup key storage."));
      } catch (error) { reject(error); }
    });
  }

  async function read() {
    let db;
    try {
      db = await open();
      const record = await new Promise((resolve, reject) => {
        const transaction = db.transaction("vault", "readonly");
        const request = transaction.objectStore("vault").get(BACKUP_VAULT_ID);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error("Could not read encrypted backup key."));
      });
      if (record && !validRecord(record)) {
        throw Object.assign(new Error("Encrypted backup vault record is malformed."), { code: "BACKUP_VAULT_INVALID" });
      }
      return record;
    } catch (error) {
      if (error?.code === "BACKUP_VAULT_INVALID") throw error;
      throw new Error("Durable IndexedDB backup-key storage is unavailable; Web Storage fallback is prohibited. " + (error?.message || ""));
    } finally { db?.close(); }
  }

  async function write(record) {
    if (!validRecord(record)) {
      throw Object.assign(new TypeError("Invalid encrypted backup vault record."), { code: "BACKUP_VAULT_INVALID" });
    }
    let db;
    try {
      db = await open();
      await new Promise((resolve, reject) => {
        const transaction = db.transaction("vault", "readwrite");
        const persisted = { id: record.id, format: record.format, wrappedKey: record.wrappedKey, salt: record.salt, wrapIv: record.wrapIv, iterations: record.iterations };
        if (record.key !== undefined) persisted.key = record.key;
        transaction.objectStore("vault").put(persisted);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error("Could not save backup recovery key."));
        transaction.onabort = () => reject(transaction.error || new Error("Backup recovery key write was aborted."));
      });
      const stored = await new Promise((resolve, reject) => {
        const transaction = db.transaction("vault", "readonly");
        const request = transaction.objectStore("vault").get(BACKUP_VAULT_ID);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error("Backup vault read-back failed."));
      });
      if (!stored || stored.id !== record.id || stored.format !== record.format ||
          stored.wrappedKey !== record.wrappedKey || stored.salt !== record.salt ||
          stored.wrapIv !== record.wrapIv || stored.iterations !== record.iterations) {
        throw Object.assign(new Error("Encrypted backup vault failed exact read-back verification."), {
          code: "BACKUP_VAULT_READBACK_FAILED"
        });
      }
      return true;
    } catch (error) {
      throw new Error("Secure IndexedDB backup-key storage is unavailable; no Web Storage fallback was written. " + (error?.message || ""));
    } finally { db?.close(); }
  }

  return Object.freeze({ read, write });
}
