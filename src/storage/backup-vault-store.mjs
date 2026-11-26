const BACKUP_VAULT_DB = "aurelia-pms-backup-vault-v1";
const BACKUP_VAULT_ID = "primary";

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
      if (record && (record.id !== BACKUP_VAULT_ID || record.format !== 1 ||
          typeof record.wrappedKey !== "string" || typeof record.salt !== "string" ||
          typeof record.wrapIv !== "string" || !Number.isSafeInteger(record.iterations))) {
        throw Object.assign(new Error("Encrypted backup vault record is malformed."), { code: "BACKUP_VAULT_INVALID" });
      }
      return record;
    } catch (error) {
      throw new Error("Durable IndexedDB backup-key storage is unavailable; Web Storage fallback is prohibited. " + (error?.message || ""));
    } finally { db?.close(); }
  }

  async function write(record) {
    if (!record || typeof record !== "object" || record.id !== BACKUP_VAULT_ID ||
        record.format !== 1 || typeof record.wrappedKey !== "string" ||
        typeof record.salt !== "string" || typeof record.wrapIv !== "string" ||
        !Number.isSafeInteger(record.iterations) || record.iterations < 1) {
      throw Object.assign(new TypeError("Invalid encrypted backup vault record."), { code: "BACKUP_VAULT_INVALID" });
    }
    let db;
    try {
      db = await open();
      await new Promise((resolve, reject) => {
        const transaction = db.transaction("vault", "readwrite");
        transaction.objectStore("vault").put(record);
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
