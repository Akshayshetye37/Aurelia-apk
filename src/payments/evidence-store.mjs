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
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Evidence record is required");
      const safeText = (value, label, max, required = false) => {
        const result = String(value ?? "").trim();
        if ((required && !result) || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) {
          throw new TypeError("Invalid " + label);
        }
        return result || null;
      };
      const evidenceId = safeText(input.evidenceId, "evidenceId", 128, true);
      const eventId = safeText(input.eventId, "eventId", 128, true);
      const source = safeText(input.source, "source", 64, true).toLowerCase();
      const parseStatus = String(input.parseStatus || "parsed").trim().toLowerCase();
      if (!["parsed", "unparsed"].includes(parseStatus)) throw new TypeError("Invalid parseStatus");
      const amountPaise = input.amountPaise == null ? null : input.amountPaise;
      if (amountPaise != null && (!Number.isSafeInteger(amountPaise) || amountPaise <= 0)) {
        throw new TypeError("amountPaise must be a positive safe integer when present");
      }
      if (parseStatus === "parsed" && amountPaise == null) {
        throw new TypeError("parsed evidence must have a positive amountPaise");
      }
      const currency = input.currency == null || String(input.currency).trim() === ""
        ? (parseStatus === "parsed" ? "INR" : null)
        : String(input.currency).trim().toUpperCase();
      if (currency && !/^[A-Z]{3}$/.test(currency)) throw new TypeError("Invalid currency code");
      if (parseStatus === "parsed" && currency !== "INR") throw new TypeError("Only INR evidence can enter automatic matching");
      const bankValue = safeText(input.bank, "bank", 64);
      const utrValue = safeText(input.utr, "UTR", 128);
      const accountScope = safeText(input.accountScope || input.accountSuffix, "accountScope", 64);
      const payerName = safeText(input.payerName, "payerName", 128);
      const upiId = safeText(input.upiId, "upiId", 128);
      const sourcePackage = safeText(input.sourcePackage, "sourcePackage", 128);
      const eventType = safeText(input.eventType || "unknown", "eventType", 64, true).toLowerCase();
      const rawEvidence = input.rawEvidence == null ? null : String(input.rawEvidence);
      if (rawEvidence && rawEvidence.length > 8192) throw new TypeError("rawEvidence exceeds 8192 characters");
      const receivedAtDate = input.receivedAt ? new Date(input.receivedAt) : new Date();
      if (Number.isNaN(receivedAtDate.getTime())) throw new TypeError("Invalid receivedAt timestamp");
      const timestampDate = input.timestamp ? new Date(input.timestamp) : null;
      if (timestampDate && Number.isNaN(timestampDate.getTime())) throw new TypeError("Invalid evidence timestamp");

      const record = {
        ...input, evidenceId, eventId, source, parseStatus, eventType,
        amountPaise, currency, bank: bankValue ? bankValue.toUpperCase() : null,
        utr: utrValue ? normalizeUtr(utrValue) : null,
        payerName, upiId, sourcePackage,
        rawEvidence,
        receivedAt: receivedAtDate.toISOString(),
        timestamp: timestampDate ? timestampDate.toISOString() : null,
        storedAt: new Date().toISOString(),
        accountScope,
        utrKey: scopedUtrKey({
          bank: bankValue, accountScope, utr: utrValue
        })
      };

      const db = await getDb();
      const checkTx = db.transaction(["dedup"], "readonly");
      const checkDone = transactionDone(checkTx);
      const dedup = checkTx.objectStore("dedup");
      const eventKey = "event:" + eventId;
      const utrKey = record.utrKey ? "utr:" + record.utrKey : null;
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
      const requested = Number(limit);
      const maxItems = Number.isSafeInteger(requested) ? Math.min(1000, Math.max(0, requested)) : 500;
      if (maxItems === 0) return [];
      const sourceFilter = source == null ? null : String(source).trim().toLowerCase();
      const db = await getDb();
      const tx = db.transaction(["evidence"], "readonly");
      const done = transactionDone(tx);
      const records = [];
      const request = tx.objectStore("evidence").index("receivedAt").openCursor(null, "prev");
      request.onerror = () => { try { tx.abort(); } catch {} };
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || records.length >= maxItems) return;
        if (!sourceFilter || cursor.value.source === sourceFilter) records.push(cursor.value);
        cursor.continue();
      };
      await done;
      return records;
    },

    async recordDecision(input) {
      const safe = (value, max) => {
        const result = String(value ?? "").trim();
        if (!result || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) throw new TypeError("Invalid review decision field");
        return result;
      };
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Review decision is required");
      const decisionId = safe(input.decisionId, 128);
      const evidenceId = safe(input.evidenceId, 128);
      const decision = safe(input.decision, 32);
      if (!["needs_review", "reviewed", "rejected", "not_a_match", "duplicate"].includes(decision)) {
        throw new TypeError("Only review-only decisions may be recorded");
      }
      const reason = safe(input.reason, 256);
      const reviewerId = safe(input.reviewerId, 128);
      const record = {
        ...input, decisionId, evidenceId, decision, reason, reviewerId,
        createdAt: input.createdAt ? new Date(input.createdAt).toISOString() : new Date().toISOString()
      };
      if (Number.isNaN(Date.parse(record.createdAt))) throw new TypeError("Invalid decision timestamp");
      const db = await getDb();
      const tx = db.transaction(["evidence", "decisions"], "readwrite");
      const done = transactionDone(tx);
      let evidenceFound = false;
      const evidenceRequest = tx.objectStore("evidence").get(evidenceId);
      evidenceRequest.onsuccess = () => {
        evidenceFound = Boolean(evidenceRequest.result);
        if (!evidenceFound) {
          try { tx.abort(); } catch {}
          return;
        }
        tx.objectStore("decisions").add(record);
      };
      try {
        await done;
      } catch (error) {
        if (!evidenceFound) throw new Error("Cannot record a decision for missing evidence");
        throw error;
      }
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
