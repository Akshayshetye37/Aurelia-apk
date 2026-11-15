/**
 * Atomic local payment-to-folio settlement.
 *
 * A payment is not considered committed until the booking, folio projection,
 * and complete recoverable PMS snapshot have been written in one repository
 * transaction (SQLite on Android / IndexedDB in browser and PWA). No
 * legacy cache write participates in this transaction.
 */
import { settlePayment, moneyToPaise } from "./settlement-service.mjs";
import {
  LEGACY_PMS_SNAPSHOT_ENTITY_ID,
  LEGACY_PMS_SNAPSHOT_KEY,
  getLegacyCompatibilityStorage,
  refreshLegacyCompatibilityCache
} from "../storage/pms-legacy-compatibility-cache.mjs";

const clone = value => value == null ? value :
  (typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value)));
const SNAPSHOT_TYPE = "audit";
const SNAPSHOT_ID = LEGACY_PMS_SNAPSHOT_ENTITY_ID;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function bookingKey(booking) {
  if (booking?.id == null || String(booking.id).trim() === "") {
    throw new TypeError("A stable booking ID is required for canonical settlement");
  }
  return String(booking.id);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function ledgerEntityId(tenantId, idempotencyKey) {
  if (!globalThis.crypto?.subtle || !globalThis.TextEncoder) {
    throw fail("LEDGER_IDENTITY_CRYPTO_UNAVAILABLE", "Secure payment ledger identity generation is unavailable.");
  }
  const bytes = new TextEncoder().encode(String(tenantId) + "\u0000" + idempotencyKey);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
  return "payment:" + hex;
}
function comparableBooking(value) {
  const copy = clone(value);
  if (copy && typeof copy === "object") {
    delete copy.updatedAt;
    delete copy.legacySource;
  }
  return copy;
}


/**
 * Posts a manually/staff-confirmed payment to canonical local storage.
 *
 * The audit snapshot is part of the same multi-entity transaction. This is
 * essential because startup recovery still needs a complete state image while
 * the remaining legacy screens are being migrated. A crash can therefore
 * leave neither a folio credit without its recovery snapshot nor a snapshot
 * claiming a payment that was not committed.
 */
export async function settlePaymentToRepository({
  bridge,
  state,
  booking,
  balanceDueFor,
  amount,
  method,
  reference = "",
  source = "manual",
  idempotencyKey,
  evidenceId = null,
  verificationConfirmed = false,
  legacyStorage = getLegacyCompatibilityStorage(),
  now = () => new Date().toISOString()
} = {}) {
  if (!bridge || typeof bridge.fetchEntity !== "function" ||
      typeof bridge.mutateEntities !== "function") {
    throw new TypeError("A bound transactional PMS repository bridge is required");
  }
  if (!state || !Array.isArray(state.b) || !booking || !state.b.includes(booking)) {
    throw new TypeError("Booking must belong to the supplied live PMS state");
  }
  if (typeof balanceDueFor !== "function") {
    throw new TypeError("A canonical folio balance calculator is required");
  }
  if (source === "verified_gateway" || source === "auto") {
    throw fail("TRUSTED_SETTLEMENT_PATH_REQUIRED",
      "Provider gateway settlement requires the separately authorized trusted settlement projector.");
  }

  const bookingId = bookingKey(booking);
  const folioId = String(booking.folioId || "booking-" + bookingId);
  const amountPaise = moneyToPaise(amount, "Payment amount");
  const suppliedLedgerKey = String(idempotencyKey || "").trim();
  if (suppliedLedgerKey.length > 256 || /[\u0000-\u001f\u007f]/.test(suppliedLedgerKey)) {
    throw fail("PAYMENT_IDEMPOTENCY_KEY_INVALID", "The payment idempotency key is invalid.");
  }
  // Flush snapshots queued by the compatibility UI before taking entity
  // versions; otherwise an older queued snapshot could race this transaction.
  if (bridge.compatibilityWrite && typeof bridge.compatibilityWrite.then === "function") {
    await bridge.compatibilityWrite;
  }
  const [snapshotRow, bookingRow, folioRow] = await Promise.all([
    bridge.fetchEntity(SNAPSHOT_TYPE, SNAPSHOT_ID),
    bridge.fetchEntity("booking", bookingId),
    bridge.fetchEntity("folio", folioId)
  ]);

  // The durable full-state snapshot, when present, is the recovery authority.
  // Domain booking data must agree with it; silently choosing either divergent
  // copy would conceal a lost update.
  const canonicalState = snapshotRow?.data?.snapshot
    ? clone(snapshotRow.data.snapshot)
    : clone(state);
  if (!Array.isArray(canonicalState.b)) {
    throw fail("CANONICAL_SNAPSHOT_INVALID", "Canonical PMS snapshot has no booking collection");
  }
  const canonicalIndex = canonicalState.b.findIndex(row => String(row?.id) === bookingId);
  if (canonicalIndex < 0) {
    throw fail("BOOKING_NOT_FOUND", "Booking is missing from the canonical PMS snapshot");
  }
  const snapshotBooking = canonicalState.b[canonicalIndex];
  if (bookingRow?.data && !sameJson(comparableBooking(bookingRow.data), comparableBooking(snapshotBooking))) {
    throw fail("CANONICAL_BOOKING_DIVERGENCE",
      "Canonical booking entity and recovery snapshot disagree; refresh the PMS before recording payment.");
  }

  const workingBooking = clone(comparableBooking(bookingRow?.data || snapshotBooking));
  canonicalState.b[canonicalIndex] = workingBooking;
  if (!Array.isArray(canonicalState.aud)) canonicalState.aud = [];
  let reviewEvidence = null;
  if (source === "staff_review") {
    if (!Array.isArray(canonicalState.sig) || !evidenceId) {
      throw fail("PAYMENT_EVIDENCE_REQUIRED", "A durable payment-evidence record is required for staff review.");
    }
    reviewEvidence = canonicalState.sig.find(row => String(row?.id) === String(evidenceId));
    if (!reviewEvidence) throw fail("PAYMENT_EVIDENCE_NOT_FOUND", "The selected payment evidence is not in the canonical local snapshot.");
    if (!["open", "pending_review", "matched"].includes(reviewEvidence.st)) {
      throw fail("PAYMENT_EVIDENCE_NOT_REVIEWABLE", "This payment evidence is no longer available for approval.");
    }
    if (String(method || "").toUpperCase() !== "UPI" ||
        moneyToPaise(reviewEvidence.amt, "Evidence amount") !== amountPaise ||
        String(reviewEvidence.ref || "").trim().replace(/\s+/g, "").toUpperCase() !==
          String(reference || "").trim().replace(/\\s+/g, "").toUpperCase()) {
      throw fail("PAYMENT_EVIDENCE_BINDING_MISMATCH", "The payment amount, UPI reference and selected evidence do not match.");
    }
    const expectedKey = reviewEvidence.ref ? "utr:" + String(reviewEvidence.ref).trim() : "signal:" + String(reviewEvidence.id);
    if (String(idempotencyKey || "") !== expectedKey) {
      throw fail("PAYMENT_EVIDENCE_IDEMPOTENCY_MISMATCH", "The payment idempotency key is not bound to the selected evidence.");
    }
  }
  const auditRows = [];
  const result = settlePayment({
    state: canonicalState,
    booking: workingBooking,
    amount,
    method,
    reference,
    source,
    idempotencyKey: suppliedLedgerKey || undefined,
    balanceDue: balanceDueFor(workingBooking),
    verificationConfirmed,
    persist: () => {},
    audit: (action, detail) => {
      const row = { a: action, d: detail, at: new Date(now()) };
      canonicalState.aud.unshift(row);
      auditRows.push(row);
    },
    now
  });

  if (reviewEvidence?.st === "matched" && !result.duplicate) {
    throw fail("PAYMENT_EVIDENCE_STATE_DIVERGENCE",
      "Evidence is marked approved but no matching canonical payment exists; reconcile before posting.");
  }
  const normalizedReference = /upi|bank|neft|rtgs|imps|card|wallet/i.test(String(method || ""))
    ? String(reference || "").trim().replace(/\\s+/g, "").toUpperCase()
    : String(reference || "").trim();
  const ledgerKey = String(result.payment?.idempotencyKey || suppliedLedgerKey ||
    (normalizedReference ? "ref:" + normalizedReference : "")).trim();
  if (!ledgerKey) {
    throw fail("PAYMENT_IDEMPOTENCY_KEY_REQUIRED", "A stable payment idempotency key is required before posting.");
  }
  const ledgerId = await ledgerEntityId(bridge.context.tenantId, ledgerKey);
  const committedAt = now();
  const ledgerEntry = {
    id: ledgerId,
    recordType: "AURELIA_FINANCIAL_LEDGER_ENTRY_V1",
    tenantId: bridge.context.tenantId,
    propertyId: bridge.context.propertyId,
    deviceId: bridge.context.deviceId,
    bookingId,
    folioId,
    amountPaise,
    currency: "INR",
    transactionType: "PAYMENT_RECEIVED",
    method: String(result.payment?.m || method || ""),
    reference: String(result.payment?.r || reference || ""),
    source: String(result.payment?.source || source),
    idempotencyKey: ledgerKey,
    reversalOf: null,
    createdAt: result.payment?.at || committedAt
  };
  const ledgerRow = await bridge.fetchEntity("ledger", ledgerId);
  if (result.duplicate) {
    const snapshotLedgerEntry = Array.isArray(canonicalState.led)
      ? canonicalState.led.find(row => row?.id === ledgerId)
      : null;
    if (!ledgerRow || !sameJson(ledgerRow.data, ledgerEntry) ||
        !sameJson(snapshotLedgerEntry, ledgerEntry)) {
      throw fail("PAYMENT_LEDGER_DIVERGENCE",
        "The existing payment has no matching immutable ledger entry and recovery projection; reconcile before retrying.");
    }
    // A duplicate is safe only if the canonical record already contains it.
    if (reviewEvidence && reviewEvidence.st !== "matched") {
      throw fail("PAYMENT_EVIDENCE_STATE_DIVERGENCE",
        "A matching payment exists but its evidence is not marked approved; reconcile the folio before proceeding.");
    }
    if (Array.isArray(state.led)) state.led.splice(0, state.led.length, ...clone(canonicalState.led || []));
    else state.led = clone(canonicalState.led || []);
    Object.assign(booking, clone(workingBooking));
    const cacheRefreshed = refreshLegacyCompatibilityCache(legacyStorage, canonicalState);
    return Object.freeze({ ...result, duplicate: true, canonical: true, ledger: ledgerRow,
      cacheRefreshed, bookingVersion: bookingRow?.version ?? 0, folioVersion: folioRow?.version ?? 0 });
  }

  if (ledgerRow) {
    throw fail("PAYMENT_LEDGER_IDEMPOTENCY_CONFLICT",
      "The payment idempotency key already has a ledger entry but no matching folio payment; reconcile before posting.");
  }
  if (!Array.isArray(canonicalState.led)) canonicalState.led = [];
  if (canonicalState.led.some(row => row?.id === ledgerId)) {
    throw fail("PAYMENT_LEDGER_SNAPSHOT_CONFLICT", "The recovery snapshot already contains this ledger identity without a matching repository row.");
  }
  canonicalState.led.push(clone(ledgerEntry));
  const paidPaise = moneyToPaise(workingBooking.p || 0, "Updated folio paid total", { allowZero: true });
  const balanceDuePaise = moneyToPaise(balanceDueFor(workingBooking), "Updated folio balance", { allowZero: true });
  if (reviewEvidence) {
    reviewEvidence.st = "matched";
    reviewEvidence.b = workingBooking.id;
    reviewEvidence.approvedAt = committedAt;
    if (!Array.isArray(reviewEvidence.reviewHistory)) reviewEvidence.reviewHistory = [];
    reviewEvidence.reviewHistory.push({
      decision: "approved",
      bookingId: workingBooking.id,
      at: committedAt,
      idempotencyKey: String(idempotencyKey)
    });
  }
  const snapshotPayload = {
    sourceKey: LEGACY_PMS_SNAPSHOT_KEY,
    operation: "payment_posted",
    bookingId,
    folioId,
    amountPaise,
    idempotencyKey: ledgerKey,
    evidenceId: evidenceId == null ? null : String(evidenceId)
  };

  const committed = await bridge.mutateEntities([
    {
      entityType: "booking",
      entityId: bookingId,
      expectedVersion: bookingRow?.version ?? 0,
      eventType: "booking.payment_posted",
      eventPayload: snapshotPayload,
      mutate: entity => { for (const key of Object.keys(entity)) delete entity[key]; Object.assign(entity, clone(workingBooking)); }
    },
    {
      entityType: "folio",
      entityId: folioId,
      expectedVersion: folioRow?.version ?? 0,
      eventType: "folio.payment_posted",
      eventPayload: snapshotPayload,
      mutate: entity => Object.assign(entity, {
        id: folioId,
        bookingId,
        paymentRows: clone(workingBooking.pays || []),
        paidPaise,
        balanceDuePaise,
        updatedAt: committedAt
      })
    },
    {
      entityType: "ledger",
      entityId: ledgerId,
      expectedVersion: 0,
      eventType: "ledger.payment_posted",
      eventPayload: snapshotPayload,
      mutate: entity => Object.assign(entity, clone(ledgerEntry))
    },
    {
      entityType: SNAPSHOT_TYPE,
      entityId: SNAPSHOT_ID,
      expectedVersion: snapshotRow?.version ?? 0,
      eventType: "pms.snapshot_payment_committed",
      eventPayload: snapshotPayload,
      mutate: entity => {
        entity.sourceKey = LEGACY_PMS_SNAPSHOT_KEY;
        entity.snapshot = clone(canonicalState);
        entity.updatedAt = committedAt;
      }
    }
  ]);

  // Exact read-back is mandatory before the UI is told the payment succeeded.
  const [storedBooking, storedFolio, storedLedger, storedSnapshot] = await Promise.all([
    bridge.fetchEntity("booking", bookingId),
    bridge.fetchEntity("folio", folioId),
    bridge.fetchEntity("ledger", ledgerId),
    bridge.fetchEntity(SNAPSHOT_TYPE, SNAPSHOT_ID)
  ]);
  if (!storedBooking || !storedFolio || !storedLedger || !storedSnapshot ||
      !sameJson(storedBooking.data, workingBooking) ||
      !sameJson(storedFolio.data.paymentRows, workingBooking.pays || []) ||
      storedFolio.data.paidPaise !== paidPaise ||
      storedFolio.data.balanceDuePaise !== balanceDuePaise ||
      !sameJson(storedLedger.data, ledgerEntry) ||
      !sameJson(storedSnapshot.data.snapshot, canonicalState)) {
    throw fail("PAYMENT_CANONICAL_READBACK_MISMATCH",
      "Payment transaction committed but exact canonical read-back failed. Stop payment entry and reconcile before retrying.");
  }

  // Refresh the old UI cache only after canonical commit. It is never the
  // authority for this operation; failure is reported separately so callers
  // do not retry and accidentally create a second payment.
  const cacheRefreshed = refreshLegacyCompatibilityCache(legacyStorage, canonicalState);

  // Keep the active UI references coherent only after durable commit/read-back.
  const liveBookings = state.b;
  const merged = canonicalState.b.map(saved => {
    const live = liveBookings.find(row => String(row?.id) === String(saved?.id));
    if (live) {
      Object.assign(live, clone(saved));
      return live;
    }
    return clone(saved);
  });
  liveBookings.splice(0, liveBookings.length, ...merged);
  state.today = canonicalState.today;
  if (Array.isArray(state.aud)) state.aud.splice(0, state.aud.length, ...clone(canonicalState.aud));
  if (Array.isArray(state.sig) && Array.isArray(canonicalState.sig)) {
    state.sig.splice(0, state.sig.length, ...clone(canonicalState.sig));
  }
  if (Array.isArray(state.led)) state.led.splice(0, state.led.length, ...clone(canonicalState.led));
  else state.led = clone(canonicalState.led);
  Object.assign(booking, clone(workingBooking));

  return Object.freeze({
    ...result,
    duplicate: false,
    canonical: true,
    entity: storedBooking,
    folio: storedFolio,
    ledger: storedLedger,
    snapshotVersion: storedSnapshot.version,
    cacheRefreshed,
    bookingVersion: committed.entities[0].version,
    folioVersion: committed.entities[1].version,
    eventSequence: committed.entities[1].version
  });
}


/**
 * Appends a full or partial reversal for an existing local payment.
 * The original payment row is never edited; the reversal, booking/folio
 * projections, audit record and recovery snapshot commit in one repository
 * batch and are read back before the caller reports success.
 */
export async function reversePaymentToRepository({
  bridge,
  state,
  booking,
  balanceDueFor,
  originalLedgerEntryId,
  amountPaise,
  idempotencyKey,
  reason,
  legacyStorage = getLegacyCompatibilityStorage(),
  now = () => new Date().toISOString()
} = {}) {
  if (!bridge || typeof bridge.fetchEntity !== "function" ||
      typeof bridge.listEntities !== "function" || typeof bridge.mutateEntities !== "function") {
    throw new TypeError("A bound transactional PMS repository bridge is required");
  }
  if (!state || !Array.isArray(state.b) || !booking || !state.b.includes(booking)) {
    throw new TypeError("Booking must belong to the supplied live PMS state");
  }
  if (typeof balanceDueFor !== "function") throw new TypeError("A canonical folio balance calculator is required");
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    throw new RangeError("Reversal amount must be a positive safe integer number of paise");
  }
  const originalId = String(originalLedgerEntryId || "").trim();
  if (!originalId || originalId.length > 256 || /[\u0000-\u001f\u007f]/.test(originalId)) {
    throw new TypeError("Original ledger entry ID is invalid");
  }
  const key = String(idempotencyKey || "").trim();
  if (!key || key.length > 256 || /[\u0000-\u001f\u007f]/.test(key)) {
    throw fail("LEDGER_REVERSAL_IDEMPOTENCY_KEY_REQUIRED", "A stable reversal idempotency key is required.");
  }
  const safeReason = String(reason || "").trim();
  if (!safeReason || safeReason.length > 256 || /[\u0000-\u001f\u007f]/.test(safeReason)) {
    throw new TypeError("Reversal reason is required and must be at most 256 characters");
  }
  if (bridge.compatibilityWrite && typeof bridge.compatibilityWrite.then === "function") {
    await bridge.compatibilityWrite;
  }

  const bookingId = bookingKey(booking);
  const folioId = String(booking.folioId || "booking-" + bookingId);
  const reversalId = await ledgerEntityId(bridge.context.tenantId, "reversal:" + key);
  const [snapshotRow, bookingRow, folioRow, originalRow, ledgerRows] = await Promise.all([
    bridge.fetchEntity(SNAPSHOT_TYPE, SNAPSHOT_ID),
    bridge.fetchEntity("booking", bookingId),
    bridge.fetchEntity("folio", folioId),
    bridge.fetchEntity("ledger", originalId),
    bridge.listEntities("ledger")
  ]);
  const original = originalRow?.data;
  if (!original || original.id !== originalId) {
    throw fail("LEDGER_ORIGINAL_NOT_FOUND", "The original immutable payment ledger entry was not found.");
  }
  if (original.recordType !== "AURELIA_FINANCIAL_LEDGER_ENTRY_V1" ||
      original.transactionType !== "PAYMENT_RECEIVED" || original.reversalOf != null ||
      original.currency !== "INR" || !Number.isSafeInteger(original.amountPaise) ||
      original.amountPaise <= 0 || original.tenantId !== bridge.context.tenantId ||
      original.propertyId !== bridge.context.propertyId || String(original.bookingId) !== bookingId ||
      original.folioId !== folioId) {
    throw fail("LEDGER_ORIGINAL_BINDING_MISMATCH", "The original payment does not match this tenant, property, booking and folio.");
  }

  const ledgerEntry = {
    id: reversalId,
    recordType: "AURELIA_FINANCIAL_LEDGER_ENTRY_V1",
    tenantId: bridge.context.tenantId,
    propertyId: bridge.context.propertyId,
    deviceId: bridge.context.deviceId,
    bookingId,
    folioId,
    amountPaise,
    currency: "INR",
    transactionType: "PAYMENT_REVERSAL",
    method: original.method,
    reference: original.reference,
    source: "reversal",
    idempotencyKey: key,
    reversalOf: originalId,
    reason: safeReason,
    createdAt: now()
  };
  const existingReversal = ledgerRows.find(row => row.id === reversalId);
  const snapshotState = snapshotRow?.data?.snapshot
    ? clone(snapshotRow.data.snapshot)
    : clone(state);
  if (!Array.isArray(snapshotState.b) || !Array.isArray(snapshotState.led)) {
    throw fail("CANONICAL_SNAPSHOT_INVALID", "Canonical PMS snapshot is missing booking or ledger collections.");
  }
  const snapshotIndex = snapshotState.b.findIndex(row => String(row?.id) === bookingId);
  if (snapshotIndex < 0) throw fail("BOOKING_NOT_FOUND", "Booking is missing from the canonical PMS snapshot.");
  const snapshotBooking = snapshotState.b[snapshotIndex];
  if (bookingRow?.data && !sameJson(comparableBooking(bookingRow.data), comparableBooking(snapshotBooking))) {
    throw fail("CANONICAL_BOOKING_DIVERGENCE", "Canonical booking entity and recovery snapshot disagree.");
  }
  const workingBooking = clone(comparableBooking(bookingRow?.data || snapshotBooking));

  if (existingReversal) {
    const comparable = value => {
      const copy = clone(value);
      if (copy && typeof copy === "object") delete copy.createdAt;
      return copy;
    };
    const snapshotEntry = snapshotState.led.find(row => row?.id === reversalId);
    if (!sameJson(comparable(existingReversal.data), comparable(ledgerEntry)) ||
        !sameJson(comparable(snapshotEntry), comparable(ledgerEntry)) ||
        !(workingBooking.paymentReversals || []).some(row => row?.id === reversalId)) {
      throw fail("LEDGER_REVERSAL_IDEMPOTENCY_CONFLICT", "Reversal idempotency key is already bound to different or incomplete data.");
    }
    Object.assign(booking, workingBooking);
    return Object.freeze({ ok: true, duplicate: true, canonical: true, ledger: existingReversal,
      bookingVersion: bookingRow?.version ?? 0, folioVersion: folioRow?.version ?? 0 });
  }

  const priorReversals = ledgerRows
    .filter(row => row.data?.transactionType === "PAYMENT_REVERSAL" && row.data?.reversalOf === originalId)
    .reduce((sum, row) => {
      const value = row.data?.amountPaise;
      if (!Number.isSafeInteger(value) || value <= 0 || row.data.currency !== original.currency) {
        throw fail("LEDGER_REVERSAL_INTEGRITY_ERROR", "An existing reversal entry is malformed.");
      }
      const next = sum + value;
      if (!Number.isSafeInteger(next)) throw new RangeError("Cumulative reversal amount exceeds the safe integer limit");
      return next;
    }, 0);
  if (priorReversals + amountPaise > original.amountPaise) {
    throw fail("LEDGER_REVERSAL_EXCEEDS_ORIGINAL", "Cumulative reversals cannot exceed the original payment amount.");
  }

  const paidPaise = moneyToPaise(workingBooking.p || 0, "Updated folio paid total", { allowZero: true });
  if (amountPaise > paidPaise) {
    throw fail("LEDGER_REVERSAL_EXCEEDS_PAID_TOTAL", "Reversal exceeds the currently recorded folio paid total.");
  }
  workingBooking.p = (paidPaise - amountPaise) / 100;
  const reversalProjection = {
    id: reversalId, originalLedgerEntryId: originalId, amountPaise,
    currency: "INR", idempotencyKey: key, reason: safeReason, createdAt: ledgerEntry.createdAt
  };
  if (!Array.isArray(workingBooking.paymentReversals)) workingBooking.paymentReversals = [];
  workingBooking.paymentReversals.push(clone(reversalProjection));
  snapshotState.b[snapshotIndex] = workingBooking;
  snapshotState.led.push(clone(ledgerEntry));
  if (!Array.isArray(snapshotState.aud)) snapshotState.aud = [];
  snapshotState.aud.unshift({ a: "Payment reversal", d: safeReason + " · " + (amountPaise / 100).toFixed(2) + " INR", at: new Date(ledgerEntry.createdAt) });

  const currentTodayPaise = snapshotState.today == null || snapshotState.today === ""
    ? 0 : moneyToPaise(snapshotState.today, "Daily payment total", { allowZero: true, allowNegative: true });
  const nextTodayPaise = currentTodayPaise - amountPaise;
  if (!Number.isSafeInteger(nextTodayPaise)) throw new RangeError("Daily payment total exceeds the safe integer limit");
  snapshotState.today = nextTodayPaise / 100;
  const balanceDuePaise = moneyToPaise(balanceDueFor(workingBooking), "Updated folio balance", { allowZero: true });
  const committedAt = ledgerEntry.createdAt;
  const eventPayload = {
    operation: "payment_reversed", originalLedgerEntryId: originalId,
    reversalLedgerEntryId: reversalId, bookingId, folioId, amountPaise, idempotencyKey: key
  };
  const nextFolio = {
    ...(folioRow?.data || {}),
    id: folioId, bookingId,
    paymentRows: clone(workingBooking.pays || []),
    reversalRows: clone(workingBooking.paymentReversals),
    paidPaise: paidPaise - amountPaise,
    balanceDuePaise,
    updatedAt: committedAt
  };

  const committed = await bridge.mutateEntities([
    {
      entityType: "booking", entityId: bookingId, expectedVersion: bookingRow?.version ?? 0,
      eventType: "booking.payment_reversed", eventPayload: eventPayload,
      mutate: entity => { for (const field of Object.keys(entity)) delete entity[field]; Object.assign(entity, clone(workingBooking)); }
    },
    {
      entityType: "folio", entityId: folioId, expectedVersion: folioRow?.version ?? 0,
      eventType: "folio.payment_reversed", eventPayload,
      mutate: entity => { for (const field of Object.keys(entity)) delete entity[field]; Object.assign(entity, clone(nextFolio)); }
    },
    {
      entityType: "ledger", entityId: reversalId, expectedVersion: 0,
      eventType: "ledger.payment_reversed", eventPayload,
      mutate: entity => Object.assign(entity, clone(ledgerEntry))
    },
    {
      entityType: SNAPSHOT_TYPE, entityId: SNAPSHOT_ID, expectedVersion: snapshotRow?.version ?? 0,
      eventType: "pms.snapshot_payment_reversed", eventPayload,
      mutate: entity => {
        entity.sourceKey = LEGACY_PMS_SNAPSHOT_KEY;
        entity.snapshot = clone(snapshotState);
        entity.updatedAt = committedAt;
      }
    }
  ]);

  const [storedBooking, storedFolio, storedLedger, storedSnapshot] = await Promise.all([
    bridge.fetchEntity("booking", bookingId), bridge.fetchEntity("folio", folioId),
    bridge.fetchEntity("ledger", reversalId), bridge.fetchEntity("audit", SNAPSHOT_ID)
  ]);
  if (!storedBooking || !storedFolio || !storedLedger || !storedSnapshot ||
      !sameJson(storedBooking.data, workingBooking) ||
      !sameJson(storedFolio.data, nextFolio) ||
      !sameJson(storedLedger.data, ledgerEntry) ||
      !sameJson(storedSnapshot.data.snapshot, snapshotState)) {
    throw fail("PAYMENT_REVERSAL_READBACK_MISMATCH", "Reversal committed but exact local read-back failed; reconcile before retrying.");
  }

  refreshLegacyCompatibilityCache(legacyStorage, snapshotState);
  const liveBookings = state.b;
  const merged = snapshotState.b.map(saved => {
    const live = liveBookings.find(row => String(row?.id) === String(saved?.id));
    if (live) { Object.assign(live, clone(saved)); return live; }
    return clone(saved);
  });
  liveBookings.splice(0, liveBookings.length, ...merged);
  state.today = snapshotState.today;
  if (Array.isArray(state.aud)) state.aud.splice(0, state.aud.length, ...clone(snapshotState.aud));
  state.led.splice(0, state.led.length, ...clone(snapshotState.led));
  Object.assign(booking, clone(workingBooking));

  return Object.freeze({
    ok: true, duplicate: false, canonical: true, ledger: storedLedger,
    entity: storedBooking, folio: storedFolio, snapshotVersion: storedSnapshot.version,
    cacheRefreshed: true, bookingVersion: committed.entities[0].version,
    folioVersion: committed.entities[1].version
  });
}
