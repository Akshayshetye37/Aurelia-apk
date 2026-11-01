/**
 * Installation-local PMS payment-intent journal.
 *
 * This stores only the PMS correlation/folio intent needed to recover the
 * workflow after a WebView restart. It is NOT the payment transaction
 * database, payment authority, or accounting ledger. Pay Bridge/backend own
 * provider transaction records; PMS folio posting remains a separate atomic
 * accounting operation and must require backend verification.
 */
const DB_NAME = "aurelia-pms-payment-intents";
const DB_VERSION = 1;
const STORE_NAME = "intents";
const TERMINAL = new Set(["SUCCESS", "FAILED", "CANCELLED"]);
const STATES = new Set([
  "CREATED", "REQUESTED", "PROCESSING", "SUCCESS", "FAILED",
  "CANCELLED", "UNKNOWN", "RECONCILIATION"
]);
const ALLOWED = {
  CREATED: new Set(["CREATED", "REQUESTED", "CANCELLED"]),
  REQUESTED: new Set(["REQUESTED", "PROCESSING", "UNKNOWN", "FAILED", "CANCELLED", "RECONCILIATION"]),
  PROCESSING: new Set(["PROCESSING", "SUCCESS", "FAILED", "CANCELLED", "UNKNOWN"]),
  SUCCESS: new Set(["SUCCESS"]),
  FAILED: new Set(["FAILED", "RECONCILIATION"]),
  CANCELLED: new Set(["CANCELLED", "RECONCILIATION"]),
  UNKNOWN: new Set(["UNKNOWN", "RECONCILIATION", "PROCESSING", "FAILED", "CANCELLED"]),
  RECONCILIATION: new Set(["RECONCILIATION", "SUCCESS", "PROCESSING", "FAILED", "CANCELLED", "UNKNOWN"])
};
const IMMUTABLE = ["requestId", "bookingId", "folioId", "amountPaise", "currency", "providerId"];

function clone(value) {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}
function validate(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new TypeError("Payment intent must be an object");
  const safeText = value => typeof value === "string" && value.length > 0 &&
    !/[\u0000-\u001f\u007f]/.test(value);
  if (!safeText(record.requestId) || record.requestId.length > 128) throw new TypeError("Invalid requestId");
  if (!STATES.has(record.state)) throw new TypeError("Invalid payment intent state");
  if (!Number.isSafeInteger(record.amountPaise) || record.amountPaise <= 0) throw new TypeError("Invalid amountPaise");
  for (const key of ["bookingId", "folioId", "currency", "providerId"]) {
    if (!safeText(record[key])) throw new TypeError("Invalid " + key);
  }
  if (record.providerId.length > 64 || record.currency !== "INR") throw new TypeError("Invalid provider or currency");
  if (record.history != null && (!Array.isArray(record.history) || record.history.length > 100)) {
    throw new TypeError("Payment intent history must contain at most 100 entries");
  }
  if (record.currency !== "INR") throw new TypeError("Only INR intents are supported");
  if (record.bridgeDispatchStarted != null && typeof record.bridgeDispatchStarted !== "boolean") {
    throw new TypeError("bridgeDispatchStarted must be boolean");
  }
  if (record.backendVerified != null && typeof record.backendVerified !== "boolean") {
    throw new TypeError("backendVerified must be boolean");
  }
  if (record.settlementAuthorized != null && typeof record.settlementAuthorized !== "boolean") {
    throw new TypeError("settlementAuthorized must be boolean");
  }
  if (record.settlementAuthorized === true &&
      (record.backendVerified !== true || record.state !== "SUCCESS")) {
    throw new TypeError("Settlement authorization requires a backend-verified SUCCESS state");
  }
  if (record.state === "SUCCESS" &&
      (record.backendVerified !== true || record.settlementAuthorized !== true)) {
    throw new TypeError("SUCCESS requires backend verification and settlement authorization");
  }
  if (record.backendSessionId != null &&
      (!safeText(record.backendSessionId) || record.backendSessionId.length > 256)) {
    throw new TypeError("Invalid backendSessionId");
  }
  if (record.bridgeTransactionId != null &&
      (!safeText(record.bridgeTransactionId) || record.bridgeTransactionId.length > 256)) {
    throw new TypeError("Invalid bridgeTransactionId");
  }
  return record;
}
function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB request failed"));
  });
}
function completed(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
  });
}

export class IndexedDbPaymentIntentStore {
  constructor({ indexedDBImpl = globalThis.indexedDB, databaseName = DB_NAME } = {}) {
    if (!indexedDBImpl) throw new TypeError("IndexedDB is unavailable; durable payment recovery cannot be enabled");
    this.indexedDB = indexedDBImpl;
    this.databaseName = databaseName;
    this.databasePromise = null;
  }

  async database() {
    if (!this.databasePromise) {
      this.databasePromise = new Promise((resolve, reject) => {
        const open = this.indexedDB.open(this.databaseName, DB_VERSION);
        open.onupgradeneeded = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: "requestId" });
            store.createIndex("state", "state", { unique: false });
            store.createIndex("updatedAt", "updatedAt", { unique: false });
          }
        };
        open.onsuccess = () => {
          const db = open.result;
          db.onversionchange = () => db.close();
          resolve(db);
        };
        open.onerror = () => reject(open.error || new Error("Could not open payment intent database"));
        open.onblocked = () => reject(new Error("Payment intent database upgrade is blocked by another open tab"));
      }).catch(error => {
        this.databasePromise = null;
        throw error;
      });
    }
    return this.databasePromise;
  }

  async put(input) {
    const record = validate(clone(input));
    const db = await this.database();
    // Older Android System WebView releases may reject the durability options
    // dictionary. Retain IndexedDB transaction atomicity with the default mode.
    let tx;
    try {
      tx = db.transaction(STORE_NAME, "readwrite", { durability: "strict" });
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      tx = db.transaction(STORE_NAME, "readwrite");
    }
    const done = completed(tx);
    const store = tx.objectStore(STORE_NAME);
    try {
      const existing = await request(store.get(record.requestId));
      if (existing) {
        for (const key of IMMUTABLE) {
          if (existing[key] !== record[key]) throw new Error("Immutable payment intent binding changed: " + key);
        }
        if (!ALLOWED[existing.state]?.has(record.state)) {
          throw new Error("Illegal payment intent state change: " + existing.state + " -> " + record.state);
        }
        if (existing.backendSessionId && record.backendSessionId &&
            existing.backendSessionId !== record.backendSessionId) {
          throw new Error("Backend session reference cannot be replaced");
        }
        if (existing.bridgeTransactionId && record.bridgeTransactionId &&
            existing.bridgeTransactionId !== record.bridgeTransactionId) {
          throw new Error("Bridge transaction reference cannot be replaced");
        }
        if (existing.bridgeDispatchStarted === true && record.bridgeDispatchStarted !== true) {
          throw new Error("Bridge dispatch marker cannot be downgraded");
        }
        if (existing.backendVerified && !record.backendVerified) {
          throw new Error("Backend verification cannot be downgraded");
        }
        if (existing.settlementAuthorized && !record.settlementAuthorized) {
          throw new Error("Settlement authorization cannot be downgraded");
        }
        record.createdAt = existing.createdAt;
        record.version = (existing.version || 1) + 1;
      } else {
        record.version = 1;
      }
      store.put(record);
      await done;
      return clone(record);
    } catch (error) {
      try { tx.abort(); } catch {}
      await done.catch(() => {});
      throw error;
    }
  }

  async get(requestId) {
    const db = await this.database();
    const tx = db.transaction(STORE_NAME, "readonly");
    const result = await request(tx.objectStore(STORE_NAME).get(requestId));
    await completed(tx);
    return result ? clone(result) : null;
  }

  async listPending() {
    const db = await this.database();
    const tx = db.transaction(STORE_NAME, "readonly");
    const rows = await request(tx.objectStore(STORE_NAME).getAll());
    await completed(tx);
    // Failed/cancelled records remain visible for late-capture reconciliation.
    // Only backend-verified SUCCESS is fully closed.
    return rows.filter(row =>
      row.state !== "SUCCESS" &&
      (row.state !== "CANCELLED" || Boolean(row.backendSessionId))
    ).map(clone);
  }
}
