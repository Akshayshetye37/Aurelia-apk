import { canonicalBytes, canonicalize } from "./canonical.mjs";
const DB_NAME = "aurelia-pms-settlement-journal";
const DB_VERSION = 3;
const STORE_NAME = "settlements";
const EVENT_STORE_NAME = "settlement_events";
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
function openWrite(db, stores = [STORE_NAME, EVENT_STORE_NAME]) {
  try { return db.transaction(stores, "readwrite", { durability: "strict" }); }
  catch (e) { if (e instanceof TypeError) return db.transaction(stores, "readwrite"); throw e; }
}
function nextEvent(identity, events, type, values, now) {
  const sequence = events.reduce((max, event) => Math.max(max, Number(event.sequence) || 0), 0) + 1;
  return { eventId: identity + "#" + String(sequence).padStart(8, "0"), identity, sequence, type, ...values, createdAt: now };
}
function projectRecord(base, events = []) {
  const record = clone(base);
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (event.type === "AUTHORIZATION_RENEWED") {
      record.authorization = clone(event.authorization);
      record.policyLease = clone(event.policyLease);
    } else if (event.type === "STATUS_TRANSITION") {
      Object.assign(record, event.patch, { status: event.status });
    }
  }
  return record;
}
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
        if (!db.objectStoreNames.contains(EVENT_STORE_NAME)) {
          const events = db.createObjectStore(EVENT_STORE_NAME, { keyPath: "eventId" });
          events.createIndex("identity", "identity", { unique: false });
          events.createIndex("createdAt", "createdAt", { unique: false });
        }
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
    const tx = openWrite(db); const done = transactionComplete(tx); done.catch(() => {});
    const store = tx.objectStore(STORE_NAME), eventsStore = tx.objectStore(EVENT_STORE_NAME);
    try {
      const [existing, events] = await Promise.all([
        request(store.get(key)), request(eventsStore.index("identity").getAll(key))
      ]);
      if (existing) {
        if (existing.payloadHash !== payloadHash) { const e = new Error("Settlement identity was reused with a different payload"); e.code = "SETTLEMENT_IDEMPOTENCY_CONFLICT"; throw e; }
        let projected = projectRecord(existing, events);
        // Renew authorization as a new immutable evidence event; never rewrite the command row.
        if (projected.status === "PENDING" && input.authorization && input.policyLease) {
          const authorization = canonicalize(input.authorization), policyLease = canonicalize(input.policyLease);
          if (JSON.stringify(projected.authorization) !== JSON.stringify(authorization) ||
              JSON.stringify(projected.policyLease) !== JSON.stringify(policyLease)) {
            const event = nextEvent(key, events, "AUTHORIZATION_RENEWED", { authorization, policyLease }, this.now());
            eventsStore.add(event);
            projected = projectRecord(existing, [...events, event]);
          }
        }
        await done; return { record: projected, duplicate: true };
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
  async #transition(key, payloadHash, status, patch) {
    const db = await this.database(); const tx = openWrite(db); const done = transactionComplete(tx); done.catch(() => {});
    const store = tx.objectStore(STORE_NAME), eventsStore = tx.objectStore(EVENT_STORE_NAME);
    try {
      const identity = safeId(key, "journal key", 700);
      const [base, events] = await Promise.all([
        request(store.get(identity)), request(eventsStore.index("identity").getAll(identity))
      ]);
      if (!base) throw new Error("Settlement journal record not found");
      const record = projectRecord(base, events);
      if (record.payloadHash !== payloadHash) throw new Error("Settlement payload hash mismatch");
      if (record.status === status) { await done; return record; }
      if (record.status !== "PENDING" || !["APPLIED", "REJECTED"].includes(status)) throw new Error("Illegal settlement journal state transition");
      const event = nextEvent(identity, events, "STATUS_TRANSITION", { status, patch: canonicalize(patch) }, this.now());
      eventsStore.add(event);
      await done;
      return projectRecord(base, [...events, event]);
    } catch (error) { try { tx.abort(); } catch {} await done.catch(() => {}); throw error; }
  }
  markApplied(key, payloadHash) { return this.#transition(key, payloadHash, "APPLIED", { appliedAt: this.now() }); }
  markRejected(key, payloadHash, reasonCode) { return this.#transition(key, payloadHash, "REJECTED", { rejectedAt: this.now(), rejectedReason: safeId(String(reasonCode || "UNKNOWN"), "reasonCode", 120) }); }
  async get(key) {
    const db = await this.database(); const tx = db.transaction([STORE_NAME, EVENT_STORE_NAME], "readonly"); const done = transactionComplete(tx); done.catch(() => {});
    const identity = safeId(key, "journal key", 700);
    const [base, events] = await Promise.all([
      request(tx.objectStore(STORE_NAME).get(identity)),
      request(tx.objectStore(EVENT_STORE_NAME).index("identity").getAll(identity))
    ]);
    await done; return base ? projectRecord(base, events) : null;
  }
  async listPending() {
    const db = await this.database(); const tx = db.transaction([STORE_NAME, EVENT_STORE_NAME], "readonly"); const done = transactionComplete(tx); done.catch(() => {});
    const [records, events] = await Promise.all([
      request(tx.objectStore(STORE_NAME).index("status").getAll("PENDING")),
      request(tx.objectStore(EVENT_STORE_NAME).getAll())
    ]);
    await done;
    const grouped = new Map();
    for (const event of events) {
      if (!grouped.has(event.identity)) grouped.set(event.identity, []);
      grouped.get(event.identity).push(event);
    }
    return records.map(record => projectRecord(record, grouped.get(record.key) || []))
      .filter(record => record.status === "PENDING")
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }
}
