/**
 * Atomic local payment-to-folio settlement.
 *
 * A payment is not considered committed until the booking, folio projection,
 * and complete recoverable PMS snapshot have been written in one repository
 * transaction (SQLite on Android / IndexedDB in browser and PWA). No
 * browser key-value storage write participates in this transaction.
 */
import { settlePayment, moneyToPaise } from "./settlement-service.mjs";
import { PMS_LEGACY_SNAPSHOT_SOURCE_KEY, PMS_LEGACY_SNAPSHOT_ENTITY_ID } from "../storage/pms-repository-contract.mjs";

const clone = value => value == null ? value :
  (typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value)));
const SNAPSHOT_TYPE = "audit";
const SNAPSHOT_ID = PMS_LEGACY_SNAPSHOT_ENTITY_ID;

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
        String(reviewEvidence.ref || "").trim().replace(/\\s+/g, "").toUpperCase() !==
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
    idempotencyKey,
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
  if (result.duplicate) {
    // A duplicate is safe only if the canonical record already contains it.
    if (reviewEvidence && reviewEvidence.st !== "matched") {
      throw fail("PAYMENT_EVIDENCE_STATE_DIVERGENCE",
        "A matching payment exists but its evidence is not marked approved; reconcile the folio before proceeding.");
    }
    Object.assign(booking, clone(workingBooking));
    const cacheRefreshed = false;
    return Object.freeze({ ...result, duplicate: true, canonical: true, cacheRefreshed,
      bookingVersion: bookingRow?.version ?? 0, folioVersion: folioRow?.version ?? 0 });
  }

  const paidPaise = moneyToPaise(workingBooking.p || 0, "Updated folio paid total", { allowZero: true });
  const balanceDuePaise = moneyToPaise(balanceDueFor(workingBooking), "Updated folio balance", { allowZero: true });
  const committedAt = now();
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
    sourceKey: PMS_LEGACY_SNAPSHOT_SOURCE_KEY,
    operation: "payment_posted",
    bookingId,
    folioId,
    amountPaise,
    idempotencyKey: String(idempotencyKey || "").trim() || null,
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
      entityType: SNAPSHOT_TYPE,
      entityId: SNAPSHOT_ID,
      expectedVersion: snapshotRow?.version ?? 0,
      eventType: "pms.snapshot_payment_committed",
      eventPayload: snapshotPayload,
      mutate: entity => {
        entity.sourceKey = PMS_LEGACY_SNAPSHOT_SOURCE_KEY;
        entity.snapshot = clone(canonicalState);
        entity.updatedAt = committedAt;
      }
    }
  ]);

  // Exact read-back is mandatory before the UI is told the payment succeeded.
  const [storedBooking, storedFolio, storedSnapshot] = await Promise.all([
    bridge.fetchEntity("booking", bookingId),
    bridge.fetchEntity("folio", folioId),
    bridge.fetchEntity(SNAPSHOT_TYPE, SNAPSHOT_ID)
  ]);
  if (!storedBooking || !storedFolio || !storedSnapshot ||
      !sameJson(storedBooking.data, workingBooking) ||
      !sameJson(storedFolio.data.paymentRows, workingBooking.pays || []) ||
      storedFolio.data.paidPaise !== paidPaise ||
      storedFolio.data.balanceDuePaise !== balanceDuePaise ||
      !sameJson(storedSnapshot.data.snapshot, canonicalState)) {
    throw fail("PAYMENT_CANONICAL_READBACK_MISMATCH",
      "Payment transaction committed but exact canonical read-back failed. Stop payment entry and reconcile before retrying.");
  }

  // Refresh the old UI cache only after canonical commit. It is never the
  // authority for this operation; failure is reported separately so callers
  // do not retry and accidentally create a second payment.
  const cacheRefreshed = refreshLegacyCache(legacyStorage, canonicalState);

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
  Object.assign(booking, clone(workingBooking));

  return Object.freeze({
    ...result,
    duplicate: false,
    canonical: true,
    entity: storedBooking,
    folio: storedFolio,
    snapshotVersion: storedSnapshot.version,
    cacheRefreshed,
    bookingVersion: committed.entities[0].version,
    folioVersion: committed.entities[1].version,
    eventSequence: committed.entities[1].version
  });
}
