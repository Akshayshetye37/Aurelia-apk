/**
 * Local durable evidence journal for the reconciliation prototype.
 *
 * IndexedDB survives app/process restarts on the same installation. It is NOT
 * a cross-device source of truth and must not be used as the production ledger.
 * Folio settlement remains disabled until a trusted backend provides atomic
 * ledger writes, authorization, durable idempotency, and audit controls.
 */
const DEFAULT_DB_NAME = "aurelia-payment-evidence";
const DB_VERSION = 1;

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}
function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
  });
}
function normalizeUtr(value) {
  return String(value || "").replace(/\s+/g, "").toUpperCase();
}
function scopedUtrKey(event) {
  const utr = normalizeUtr(event.utr);
  const bank = String(event.bank || "").trim().toUpperCase();
  if (!utr || !bank) return null;
  const scope = String(event.accountScope || event.accountSuffix || "UNSCOPED").trim().toUpperCase();
  return [bank, scope, utr].join("|");
}

export function openEvidenceDatabase({ indexedDB = globalThis.indexedDB, dbName = DEFAULT_DB_NAME } = {}) {
  if (!indexedDB || typeof indexedDB.open !== "function") {
    return Promise.reject(new Error("IndexedDB is unavailable; evidence cannot be persisted"));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("evidence")) {
        const evidence = db.createObjectStore("evidence", { keyPath: "evidenceId" });
        evidence.createIndex("eventId", "eventId", { unique: true });
        evidence.createIndex("receivedAt", "receivedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains("dedup")) db.createObjectStore("dedup", { keyPath: "key" });
      if (!db.objectStoreNames.contains("decisions")) {
        const decisions = db.createObjectStore("decisions", { keyPath: "decisionId" });
        decisions.createIndex("evidenceId", "evidenceId", { unique: false });
        decisions.createIndex("createdAt", "createdAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open evidence database"));
    request.onblocked = () => reject(new Error("Evidence database upgrade is blocked by another open client"));
  });
}

export function createEvidenceStore(options = {}) {
  let dbPromise;
  const getDb = () => (dbPromise ||= openEvidenceDatabase(options));

  return {
    async addEvidence(input) {
      if (!input || typeof input !== "object") throw new TypeError("Evidence record is required");
      const evidenceId = String(input.evidenceId || "").trim();
      const eventId = String(input.eventId || "").trim();
      const source = String(input.source || "").trim();
      if (!evidenceId || !eventId || !source) throw new TypeError("evidenceId, eventId, and source are required");
      const parseStatus = String(input.parseStatus || "parsed");
      const amountPaise = input.amountPaise == null ? null : input.amountPaise;
      if (amountPaise != null && (!Number.isSafeInteger(amountPaise) || amountPaise <= 0)) {
        throw new TypeError("amountPaise must be a positive integer when present");
      }
      if (parseStatus !== "unparsed" && amountPaise == null) {
        throw new TypeError("parsed evidence must have a positive amountPaise");
      }

      const record = {
        ...input, evidenceId, eventId, source, parseStatus,
        amountPaise,
        currency: String(input.currency || "INR").toUpperCase(),
        bank: input.bank ? String(input.bank).trim().toUpperCase() : null,
        utr: input.utr ? normalizeUtr(input.utr) : null,
        rawEvidence: input.rawEvidence == null ? null : String(input.rawEvidence),
        receivedAt: input.receivedAt || new Date().toISOString(),
        storedAt: new Date().toISOString(),
        accountScope: input.accountScope || input.accountSuffix || null,
        utrKey: scopedUtrKey(input)
      };

      const db = await getDb();
      const checkTx = db.transaction(["dedup"], "readonly");
      const checkDone = transactionDone(checkTx);
      const dedup = checkTx.objectStore("dedup");
      const eventKey = `event:${eventId}`;
      const utrKey = record.utrKey ? `utr:${record.utrKey}` : null;
      const eventRequest = dedup.get(eventKey);
      const utrRequest = utrKey ? dedup.get(utrKey) : null;
      const [existingEvent, existingUtr] = await Promise.all([
        requestValue(eventRequest), utrRequest ? requestValue(utrRequest) : Promise.resolve(null)
      ]);
      await checkDone;
      if (existingEvent) return { added: false, reason: "duplicate_event", existingEvidenceId: existingEvent.evidenceId };
      if (existingUtr) return { added: false, reason: "duplicate_utr", existingEvidenceId: existingUtr.evidenceId };

      const tx = db.transaction(["evidence", "dedup"], "readwrite");
      const done = transactionDone(tx);
      tx.objectStore("evidence").add(record);
      tx.objectStore("dedup").add({ key: eventKey, kind: "event", evidenceId });
      if (utrKey) tx.objectStore("dedup").add({ key: utrKey, kind: "utr", evidenceId });
      try {
        await done;
        return { added: true, record };
      } catch (error) {
        if (error?.name === "ConstraintError" || tx.error?.name === "ConstraintError") {
          return { added: false, reason: "duplicate_conflict" };
        }
        throw error;
      }
    },

    async getEvidence(evidenceId) {
      const db = await getDb();
      const tx = db.transaction(["evidence"], "readonly");
      const done = transactionDone(tx);
      const result = await requestValue(tx.objectStore("evidence").get(String(evidenceId)));
      await done;
      return result || null;
    },

    async listEvidence({ source = null, limit = 500 } = {}) {
      const db = await getDb();
      const tx = db.transaction(["evidence"], "readonly");
      const done = transactionDone(tx);
      const records = await requestValue(tx.objectStore("evidence").getAll());
      await done;
      const filtered = source ? records.filter(record => record.source === source) : records;
      return filtered.sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)))
        .slice(0, Math.max(0, Number(limit) || 0));
    },

    async recordDecision(input) {
      if (!input || typeof input !== "object" || !String(input.decisionId || "").trim() ||
          !String(input.evidenceId || "").trim() || !String(input.decision || "").trim()) {
        throw new TypeError("decisionId, evidenceId, and decision are required");
      }
      const record = { ...input, decisionId: String(input.decisionId), evidenceId: String(input.evidenceId),
        createdAt: input.createdAt || new Date().toISOString() };
      const db = await getDb();
      const tx = db.transaction(["decisions"], "readwrite");
      const done = transactionDone(tx);
      tx.objectStore("decisions").add(record);
      await done;
      return record;
    },

    async listDecisions(evidenceId = null) {
      const db = await getDb();
      const tx = db.transaction(["decisions"], "readonly");
      const done = transactionDone(tx);
      const records = await requestValue(tx.objectStore("decisions").getAll());
      await done;
      return evidenceId ? records.filter(record => record.evidenceId === evidenceId) : records;
    },

    async close() {
      if (dbPromise) (await dbPromise).close();
      dbPromise = null;
    }
  };
}
