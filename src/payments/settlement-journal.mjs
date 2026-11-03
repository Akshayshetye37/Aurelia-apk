const DB_NAME = "aurelia-pms-settlement-journal";
const DB_VERSION = 1;
const STORE_NAME = "settlements";

function clone(value) {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((out, key) => {
      if (value[key] !== undefined) out[key] = canonicalize(value[key]);
      return out;
    }, {});
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("Settlement payload contains a non-finite number");
  }
  return value;
}

function safeId(value, label, max = 256) {
  if (typeof value !== "string" || !value.trim() || value.length > max ||
      /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError("Invalid " + label);
  }
  return value.trim();
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Settlement journal request failed"));
  });
}

function transactionComplete(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error || new Error("Settlement journal transaction failed"));
  });
}

async function sha256Hex(value, cryptoImpl) {
  if (!cryptoImpl?.subtle) throw new Error("Web Crypto is unavailable; durable settlement is disabled");
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = await cryptoImpl.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export class IndexedDbSettlementJournal {
  constructor({
    indexedDBImpl = globalThis.indexedDB,
    cryptoImpl = globalThis.crypto,
    databaseName = DB_NAME,
    now = () => new Date().toISOString()
  } = {}) {
    if (!indexedDBImpl) throw new Error("IndexedDB is unavailable; durable settlement is disabled");
    this.indexedDB = indexedDBImpl;
    this.crypto = cryptoImpl;
    this.databaseName = databaseName;
    this.now = now;
    this.databasePromise = null;
  }

  async database() {
    if (!this.databasePromise) {
      this.databasePromise = new Promise((resolve, reject) => {
        const open = this.indexedDB.open(this.databaseName, DB_VERSION);
        open.onupgradeneeded = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
            store.createIndex("status", "status", { unique: false });
            store.createIndex("createdAt", "createdAt", { unique: false });
          }
        };
        open.onsuccess = () => {
          const db = open.result;
          db.onversionchange = () => db.close();
          resolve(db);
        };
        open.onerror = () => reject(open.error || new Error("Could not open settlement journal"));
        open.onblocked = () => reject(new Error("Settlement journal upgrade is blocked by another open tab"));
      }).catch(error => {
        this.databasePromise = null;
        throw error;
      });
    }
    return this.databasePromise;
  }

  async append(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("Settlement journal input must be an object");
    }
    const provider = safeId(String(input.provider || "").toLowerCase(), "provider", 64);
    const providerTransactionId = input.providerTransactionId == null
      ? "" : safeId(input.providerTransactionId, "providerTransactionId");
    const commandId = input.commandId == null ? "" : safeId(input.commandId, "commandId");
    if (!providerTransactionId && !commandId) {
      throw new TypeError("A provider transaction ID or command ID is required");
    }
    const key = provider + ":" + (providerTransactionId
      ? "transaction:" + providerTransactionId
      : "command:" + commandId);
    const payload = canonicalize(clone(input.payload));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new TypeError("Settlement payload must be an object");
    }
    const payloadHash = await sha256Hex(payload, this.crypto);
    const db = await this.database();
    let tx;
    try {
      tx = db.transaction(STORE_NAME, "readwrite", { durability: "strict" });
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      tx = db.transaction(STORE_NAME, "readwrite");
    }
    const done = transactionComplete(tx);
    const store = tx.objectStore(STORE_NAME);
    try {
      const existing = await request(store.get(key));
      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          const conflict = new Error("Settlement identity was reused with a different payload");
          conflict.code = "SETTLEMENT_IDEMPOTENCY_CONFLICT";
          throw conflict;
        }
        await done;
        return { record: clone(existing), duplicate: true };
      }
      const record = {
        key, provider, providerTransactionId: providerTransactionId || null,
        commandId: commandId || null, payload, payloadHash,
        status: "PENDING", createdAt: this.now(), appliedAt: null
      };
      store.add(record);
      await done;
      return { record: clone(record), duplicate: false };
    } catch (error) {
      try { tx.abort(); } catch {}
      await done.catch(() => {});
      if (error?.name === "ConstraintError") {
        const winner = await this.get(key);
        if (winner?.payloadHash === payloadHash) return { record: winner, duplicate: true };
        const conflict = new Error("Settlement identity was reused with a different payload");
        conflict.code = "SETTLEMENT_IDEMPOTENCY_CONFLICT";
        throw conflict;
      }
      throw error;
    }
  }

  async markApplied(key, payloadHash) {
    const db = await this.database();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const done = transactionComplete(tx);
    const store = tx.objectStore(STORE_NAME);
    try {
      const record = await request(store.get(key));
      if (!record) throw new Error("Settlement journal record not found");
      if (record.payloadHash !== payloadHash) throw new Error("Settlement payload hash mismatch");
      if (record.status === "APPLIED") {
        await done;
        return clone(record);
      }
      if (record.status !== "PENDING") throw new Error("Illegal settlement journal state");
      record.status = "APPLIED";
      record.appliedAt = this.now();
      store.put(record);
      await done;
      return clone(record);
    } catch (error) {
      try { tx.abort(); } catch {}
      await done.catch(() => {});
      throw error;
    }
  }

  async get(key) {
    const db = await this.database();
    const tx = db.transaction(STORE_NAME, "readonly");
    const done = transactionComplete(tx);
    const record = await request(tx.objectStore(STORE_NAME).get(key));
    await done;
    return record ? clone(record) : null;
  }

  async listPending() {
    const db = await this.database();
    const tx = db.transaction(STORE_NAME, "readonly");
    const done = transactionComplete(tx);
    const records = await request(tx.objectStore(STORE_NAME).index("status").getAll("PENDING"));
    await done;
    return records.map(clone);
  }
}

export async function applyJournaledSettlement({ journal, input, applyProjection } = {}) {
  if (!journal || typeof journal.append !== "function" ||
      typeof journal.markApplied !== "function" ||
      typeof applyProjection !== "function") {
    throw new TypeError("Journal and projection callback are required");
  }
  const { record, duplicate } = await journal.append(input);
  let appliedRecord = record;
  if (record.status !== "APPLIED") {
    await applyProjection(clone(record.payload), record);
    appliedRecord = await journal.markApplied(record.key, record.payloadHash);
  }
  return { ok: true, duplicate, record: appliedRecord };
}
