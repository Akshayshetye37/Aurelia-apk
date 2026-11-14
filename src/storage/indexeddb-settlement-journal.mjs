import { canonicalBytes, canonicalize } from "../payments/canonical.mjs";
const DB_NAME = "aurelia-pms-settlement-journal";
const DB_VERSION = 2;
const STORE_NAME = "settlements";
const clone = value => structuredClone(value);
function safeId(value, label, max = 128) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError("Invalid " + label);
  return value;
}
function request(req) { return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error || new Error("Settlement journal request failed")); }); }
function transactionComplete(tx) { return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error || new Error("Settlement journal transaction failed")); }); }
async function sha256Hex(value, cryptoImpl) {
  if (!cryptoImpl?.subtle) throw new Error("Web Crypto is unavailable; durable settlement is disabled");
  const digest = await cryptoImpl.subtle.digest("SHA-256", canonicalBytes(value));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}
function openWrite(db) { try { return db.transaction(STORE_NAME, "readwrite", { durability: "strict" }); } catch (e) { if (e instanceof TypeError) return db.transaction(STORE_NAME, "readwrite"); throw e; } }
export class IndexedDbSettlementJournal {
  constructor({ indexedDBImpl = globalThis.indexedDB, cryptoImpl = globalThis.crypto, databaseName = DB_NAME, now = () => new Date().toISOString() } = {}) {
    if (!indexedDBImpl) throw new Error("IndexedDB is unavailable; durable settlement is disabled");
    this.indexedDB = indexedDBImpl; this.crypto = cryptoImpl; this.databaseName = databaseName; this.now = now; this.databasePromise = null;
  }
  async database() {
    if (!this.databasePromise) this.databasePromise = new Promise((resolve, reject) => {
      const open = this.indexedDB.open(this.databaseName, DB_VERSION);
      open.onupgradeneeded = () => {
        const db = open.result; const tx = open.transaction;
        const store = db.objectStoreNames.contains(STORE_NAME) ? tx.objectStore(STORE_NAME) : db.createObjectStore(STORE_NAME, { keyPath: "key" });
        if (!store.indexNames.contains("status")) store.createIndex("status", "status", { unique: false });
        if (!store.indexNames.contains("createdAt")) store.createIndex("createdAt", "createdAt", { unique: false });
      };
      open.onsuccess = () => { const db = open.result; db.onversionchange = () => db.close(); resolve(db); };
      open.onerror = () => reject(open.error || new Error("Could not open settlement journal"));
      open.onblocked = () => reject(new Error("Settlement journal migration is blocked by another open tab"));
    }).catch(error => { this.databasePromise = null; throw error; });
    return this.databasePromise;
  }
  static keyFor(input) {
    const tenant = safeId(input.tenantId, "tenantId");
    const provider = safeId(input.provider, "provider").toLowerCase();
    const account = safeId(input.providerAccountId, "providerAccountId");
    const environment = safeId(input.environment, "environment");
    if (!new Set(["test", "live"]).has(environment)) throw new TypeError("Invalid provider environment");
    const identity = input.providerTransactionId ? "transaction:" + safeId(input.providerTransactionId, "providerTransactionId") : "command:" + safeId(input.commandId, "commandId");
    return [tenant, provider, account, environment, identity].join("|");
  }
  async append(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Settlement journal input must be an object");
    const scope = { tenantId: safeId(input.tenantId, "tenantId"), deviceId: safeId(input.deviceId, "deviceId"),
      provider: safeId(input.provider, "provider").toLowerCase(), providerAccountId: safeId(input.providerAccountId, "providerAccountId"),
      environment: safeId(input.environment, "environment") };
    const providerTransactionId = input.providerTransactionId == null ? null : safeId(input.providerTransactionId, "providerTransactionId");
    const commandId = input.commandId == null ? null : safeId(input.commandId, "commandId");
    if (!providerTransactionId && !commandId) throw new TypeError("Provider transaction ID or command ID is required");
    const key = IndexedDbSettlementJournal.keyFor({ ...scope, providerTransactionId, commandId });
    const payload = canonicalize(input.payload);
    if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
        !payload.command || typeof payload.command !== "object" || Array.isArray(payload.command)) throw new TypeError("Settlement payload must contain a command object");
    for (const field of ["tenantId", "deviceId", "provider", "providerAccountId", "environment"]) {
      if (payload.command[field] !== scope[field]) throw new TypeError("Settlement command scope mismatch: " + field);
    }
    if ((payload.command.providerTransactionId ?? null) !== providerTransactionId ||
        (payload.command.commandId ?? null) !== commandId) throw new TypeError("Settlement command identity mismatch");
    const payloadHash = await sha256Hex(payload, this.crypto); const db = await this.database();
    const tx = openWrite(db); const done = transactionComplete(tx); done.catch(() => {}); const store = tx.objectStore(STORE_NAME);
    try {
      const existing = await request(store.get(key));
      if (existing) {
        if (existing.payloadHash !== payloadHash) { const e = new Error("Settlement identity was reused with a different payload"); e.code = "SETTLEMENT_IDEMPOTENCY_CONFLICT"; throw e; }
        // Signed authorization and short policy lease are renewable evidence.
        // The immutable command payload/hash remains unchanged across redelivery.
        if (existing.status === "PENDING" && input.authorization && input.policyLease) {
          existing.authorization = canonicalize(input.authorization);
          existing.policyLease = canonicalize(input.policyLease);
          store.put(existing);
        }
        await done; return { record: clone(existing), duplicate: true };
      }
      const record = { key, ...scope, providerTransactionId, commandId, payload, payloadHash,
        authorization: input.authorization ? canonicalize(input.authorization) : null,
        policyLease: input.policyLease ? canonicalize(input.policyLease) : null,
        status: "PENDING", createdAt: this.now(), appliedAt: null, rejectedAt: null, rejectedReason: null };
      store.add(record); await done; return { record: clone(record), duplicate: false };
    } catch (error) {
      try { tx.abort(); } catch {} await done.catch(() => {});
      if (error?.name === "ConstraintError") {
        const winner = await this.get(key);
        if (winner?.payloadHash === payloadHash) return { record: winner, duplicate: true };
        const conflict = new Error("Settlement identity was reused with a different payload"); conflict.code = "SETTLEMENT_IDEMPOTENCY_CONFLICT"; throw conflict;
      }
      throw error;
    }
  }
  async transition(key, payloadHash, status, patch) {
    const db = await this.database(); const tx = openWrite(db); const done = transactionComplete(tx); done.catch(() => {}); const store = tx.objectStore(STORE_NAME);
    try {
      const record = await request(store.get(safeId(key, "journal key", 700)));
      if (!record) throw new Error("Settlement journal record not found");
      if (record.payloadHash !== payloadHash) throw new Error("Settlement payload hash mismatch");
      if (record.status === status) { await done; return clone(record); }
      if (record.status !== "PENDING" || !["APPLIED", "REJECTED"].includes(status)) throw new Error("Illegal settlement journal state transition");
      Object.assign(record, { status }, patch); store.put(record); await done; return clone(record);
    } catch (error) { try { tx.abort(); } catch {} await done.catch(() => {}); throw error; }
  }
  markApplied(key, payloadHash) { return this.transition(key, payloadHash, "APPLIED", { appliedAt: this.now() }); }
  markRejected(key, payloadHash, reasonCode) { return this.transition(key, payloadHash, "REJECTED", { rejectedAt: this.now(), rejectedReason: safeId(String(reasonCode || "UNKNOWN"), "reasonCode", 120) }); }
  async get(key) {
    const db = await this.database(); const tx = db.transaction(STORE_NAME, "readonly"); const done = transactionComplete(tx); done.catch(() => {});
    const row = await request(tx.objectStore(STORE_NAME).get(safeId(key, "journal key", 700))); await done; return row ? clone(row) : null;
  }
  async listPending() {
    const db = await this.database(); const tx = db.transaction(STORE_NAME, "readonly"); const done = transactionComplete(tx); done.catch(() => {});
    const rows = await request(tx.objectStore(STORE_NAME).index("status").getAll("PENDING")); await done;
    return rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).map(clone);
  }
}
