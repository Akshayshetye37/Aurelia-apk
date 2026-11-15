import { canonicalBytes } from '../payments/canonical.mjs';

const DB_NAME = 'aurelia-local-ledger-receipt-outbox';
const DB_VERSION = 1;
const STORE = 'receipts';
const clone = value => structuredClone(value);

function safeId(value, label) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() ||
      value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError('invalid_receipt_outbox_' + label);
  }
  return value;
}
function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('receipt_outbox_request_failed'));
  });
}
function complete(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('receipt_outbox_transaction_failed'));
  });
}
async function hashReceipt(receipt, cryptoImpl) {
  if (!cryptoImpl?.subtle) throw new Error('receipt_outbox_crypto_unavailable');
  const digest = await cryptoImpl.subtle.digest('SHA-256', canonicalBytes(receipt));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
function openWrite(db) {
  try { return db.transaction(STORE, 'readwrite', { durability: 'strict' }); }
  catch (error) { if (error instanceof TypeError) return db.transaction(STORE, 'readwrite'); throw error; }
}

export class IndexedDbLocalLedgerReceiptOutbox {
  constructor({
    indexedDBImpl = globalThis.indexedDB,
    cryptoImpl = globalThis.crypto,
    databaseName = DB_NAME,
    now = () => new Date().toISOString()
  } = {}) {
    if (!indexedDBImpl) throw new Error('receipt_outbox_indexeddb_unavailable');
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
          const store = db.objectStoreNames.contains(STORE)
            ? open.transaction.objectStore(STORE)
            : db.createObjectStore(STORE, { keyPath: 'receiptId' });
          if (!store.indexNames.contains('status')) store.createIndex('status', 'status', { unique: false });
          if (!store.indexNames.contains('nextAttemptAt')) store.createIndex('nextAttemptAt', 'nextAttemptAt', { unique: false });
        };
        open.onsuccess = () => {
          const db = open.result;
          db.onversionchange = () => db.close();
          resolve(db);
        };
        open.onerror = () => reject(open.error || new Error('receipt_outbox_open_failed'));
        open.onblocked = () => reject(new Error('receipt_outbox_upgrade_blocked'));
      }).catch(error => { this.databasePromise = null; throw error; });
    }
    return this.databasePromise;
  }

  async enqueue(receipt) {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
        !safeId(receipt.receiptId, 'receipt_id') ||
        !safeId(receipt.intentId, 'intent_id') ||
        typeof receipt.signature !== 'string' || !receipt.signature ||
        !Number.isFinite(Date.parse(receipt.expiresAt))) {
      throw new TypeError('invalid_local_ledger_receipt');
    }
    const receiptHash = await hashReceipt(receipt, this.crypto);
    const db = await this.database();
    const tx = openWrite(db);
    const done = complete(tx); done.catch(() => {});
    const store = tx.objectStore(STORE);
    try {
      const existing = await request(store.get(receipt.receiptId));
      if (existing) {
        if (existing.receiptHash !== receiptHash) {
          const error = new Error('receipt_outbox_idempotency_conflict');
          error.code = 'RECEIPT_OUTBOX_IDEMPOTENCY_CONFLICT';
          throw error;
        }
        await done;
        return { record: clone(existing), duplicate: true };
      }
      const createdAt = this.now();
      const record = {
        receiptId: receipt.receiptId,
        intentId: receipt.intentId,
        receipt: clone(receipt),
        receiptHash,
        status: 'PENDING',
        attempts: 0,
        createdAt,
        updatedAt: createdAt,
        nextAttemptAt: createdAt,
        acceptedAt: null,
        rejectedAt: null,
        rejectionCode: null
      };
      store.add(record);
      await done;
      return { record: clone(record), duplicate: false };
    } catch (error) {
      try { tx.abort(); } catch {}
      await done.catch(() => {});
      throw error;
    }
  }

  async listDue(now = this.now(), limit = 100) {
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) throw new TypeError('invalid_receipt_outbox_clock');
    const db = await this.database();
    const tx = db.transaction(STORE, 'readonly');
    const done = complete(tx); done.catch(() => {});
    const rows = await request(tx.objectStore(STORE).index('status').getAll('PENDING'));
    await done;
    return rows.filter(row => Date.parse(row.nextAttemptAt) <= nowMs &&
      Date.parse(row.receipt.expiresAt) > nowMs)
      .sort((a, b) => String(a.nextAttemptAt).localeCompare(String(b.nextAttemptAt)))
      .slice(0, Math.max(1, Math.min(100, limit))).map(clone);
  }

  async recordAttempt(receiptId, now = this.now()) {
    safeId(receiptId, 'receipt_id');
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) throw new TypeError('invalid_receipt_outbox_clock');
    const db = await this.database();
    const tx = openWrite(db);
    const done = complete(tx); done.catch(() => {});
    const store = tx.objectStore(STORE);
    const record = await request(store.get(receiptId));
    if (!record) throw new Error('receipt_outbox_record_not_found');
    if (record.status !== 'PENDING') { await done; return clone(record); }
    if (Date.parse(record.receipt.expiresAt) <= nowMs) {
      Object.assign(record, { status: 'EXPIRED', updatedAt: now, rejectionCode: 'RECEIPT_EXPIRED' });
    } else {
      const attempts = record.attempts + 1;
      const delayMs = Math.min(15 * 60 * 1000, 1000 * (2 ** Math.min(attempts - 1, 10)));
      Object.assign(record, {
        attempts, lastAttemptAt: now,
        nextAttemptAt: new Date(Math.min(nowMs + delayMs, Date.parse(record.receipt.expiresAt))).toISOString(),
        updatedAt: now
      });
    }
    store.put(record);
    await done;
    return clone(record);
  }

  async markAccepted(receiptId, response, now = this.now()) {
    safeId(receiptId, 'receipt_id');
    if (!response || response.accepted !== true || response.receiptId !== receiptId) {
      throw new Error('receipt_outbox_backend_acceptance_unverified');
    }
    const db = await this.database();
    const tx = openWrite(db);
    const done = complete(tx); done.catch(() => {});
    const store = tx.objectStore(STORE);
    const record = await request(store.get(receiptId));
    if (!record) throw new Error('receipt_outbox_record_not_found');
    if (record.status === 'ACCEPTED') { await done; return { record: clone(record), duplicate: true }; }
    if (record.status !== 'PENDING') throw new Error('receipt_outbox_not_pending');
    Object.assign(record, { status: 'ACCEPTED', acceptedAt: now, updatedAt: now });
    store.put(record);
    await done;
    return { record: clone(record), duplicate: false };
  }

  async markRejected(receiptId, rejectionCode, now = this.now()) {
    safeId(receiptId, 'receipt_id');
    safeId(String(rejectionCode || ''), 'rejection_code');
    const db = await this.database();
    const tx = openWrite(db);
    const done = complete(tx); done.catch(() => {});
    const store = tx.objectStore(STORE);
    const record = await request(store.get(receiptId));
    if (!record) throw new Error('receipt_outbox_record_not_found');
    if (record.status === 'REJECTED') {
      if (record.rejectionCode !== rejectionCode) throw new Error('receipt_outbox_rejection_conflict');
      await done;
      return { record: clone(record), duplicate: true };
    }
    if (record.status !== 'PENDING') throw new Error('receipt_outbox_not_pending');
    Object.assign(record, {
      status: 'REJECTED', rejectedAt: now,
      rejectionCode: String(rejectionCode), updatedAt: now
    });
    store.put(record);
    await done;
    return { record: clone(record), duplicate: false };
  }

  async sweepExpired(now = this.now()) {
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) throw new TypeError('invalid_receipt_outbox_clock');
    const db = await this.database();
    const tx = openWrite(db);
    const done = complete(tx); done.catch(() => {});
    const store = tx.objectStore(STORE);
    const rows = await request(store.getAll());
    let expired = 0;
    for (const record of rows) {
      if (record.status === 'PENDING' && Date.parse(record.receipt.expiresAt) <= nowMs) {
        Object.assign(record, { status: 'EXPIRED', updatedAt: now, rejectionCode: 'RECEIPT_EXPIRED' });
        store.put(record);
        expired++;
      }
    }
    await done;
    return { expired };
  }

  async listReviewRequired() {
    const db = await this.database();
    const tx = db.transaction(STORE, 'readonly');
    const done = complete(tx); done.catch(() => {});
    const rows = await request(tx.objectStore(STORE).getAll());
    await done;
    return rows.filter(row => ['EXPIRED', 'REJECTED'].includes(row.status)).map(clone);
  }

  async get(receiptId) {
    safeId(receiptId, 'receipt_id');
    const db = await this.database();
    const tx = db.transaction(STORE, 'readonly');
    const done = complete(tx); done.catch(() => {});
    const row = await request(tx.objectStore(STORE).get(receiptId));
    await done;
    return row ? clone(row) : null;
  }
}
