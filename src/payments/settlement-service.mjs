import { AUTO_FOLIO_SETTLEMENT_ENABLED, assertAutoFolioSettlementEnabled } from "./settlement-gate.mjs";
import { assertBalanceMutationAllowed } from "./payment-safety-gate.mjs";

/**
 * Single local mutation boundary for hotel folio payments.
 *
 * This protects a single PMS installation. It is not a cross-device or
 * server-side transaction; gateway settlement remains disabled until a
 * trusted backend and atomic ledger are available.
 */
const ALLOWED_SOURCES = new Set(["manual", "staff_review", "reservation_advance", "auto"]);
const MAX_REFERENCE_LENGTH = 256;
const MAX_METHOD_LENGTH = 40;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const MONEY_TOLERANCE = 1e-7;

export function moneyToPaise(value, label, { allowZero = false } = {}) {
  const validType = typeof value === "number" ||
    (typeof value === "string" && /^\d+(?:\.\d{1,2})?$/.test(value.trim()));
  const amount = validType ? Number(value) : Number.NaN;
  if (!Number.isFinite(amount) || amount < 0 || (!allowZero && amount <= 0)) {
    throw new RangeError(label + (allowZero ? " must be zero or greater" : " must be greater than zero"));
  }
  const scaled = amount * 100;
  const paise = Math.round(scaled);
  if (!Number.isSafeInteger(paise) || Math.abs(scaled - paise) > MONEY_TOLERANCE) {
    throw new RangeError(label + " must have no more than two decimal places");
  }
  return paise;
}

function normalizedReference(value) {
  return String(value || "").trim();
}

function normalizedPaymentMethod(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizedPaymentReference(value, method) {
  const reference = normalizedReference(value);
  return /upi|bank|neft|rtgs|imps|card|wallet/i.test(String(method || ""))
    ? reference.replace(/\s+/g, "").toUpperCase()
    : reference;
}

function paymentRowPaise(row, label) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new TypeError(label + " must be an object");
  }
  const hasMinor = row.amountPaise !== undefined && row.amountPaise !== null;
  const hasMajor = row.a !== undefined && row.a !== null ||
    row.amount !== undefined && row.amount !== null;
  const minor = hasMinor && Number.isSafeInteger(row.amountPaise) && row.amountPaise > 0
    ? row.amountPaise : null;
  if (hasMinor && minor === null) throw new RangeError(label + " has invalid paise precision");
  const major = hasMajor ? moneyToPaise(row.a ?? row.amount, label) : null;
  if (hasMajor && major === null) throw new RangeError(label + " has invalid major-unit amount");
  if (minor !== null && major !== null && minor !== major) {
    throw new RangeError(label + " major-unit and paise values disagree");
  }
  const amount = minor ?? major;
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new RangeError(label + " must be a positive safe integer in paise");
  }
  return amount;
}

function paymentRowSignature(row, label) {
  const amountPaise = paymentRowPaise(row, label);
  const method = normalizedPaymentMethod(row.m ?? row.method);
  const reference = normalizedPaymentReference(row.r ?? row.reference, method);
  return JSON.stringify([
    amountPaise, method, reference, String(row.source ?? ""),
    String(row.bookingId ?? ""), String(row.idempotencyKey ?? "")
  ]);
}

/**
 * Rejects a new folio mutation when the existing paid total, canonical
 * payment rows or compatibility history disagree. This is a guard only; it
 * never chooses a winning representation or repairs historical data.
 */
export function assertBookingAccountingConsistent(booking) {
  if (!booking || typeof booking !== "object" || Array.isArray(booking)) {
    throw new TypeError("Booking is required for accounting integrity validation");
  }
  if (booking.pays != null && !Array.isArray(booking.pays)) {
    throw new TypeError("Canonical payment rows are not an array");
  }
  if (booking.payments != null && !Array.isArray(booking.payments)) {
    throw new TypeError("Compatibility payment history is not an array");
  }
  const pays = Array.isArray(booking.pays) ? booking.pays : [];
  const rowSumPaise = pays.reduce((sum, row) => {
    const amount = paymentRowPaise(row, "Existing payment amount");
    const next = sum + amount;
    if (!Number.isSafeInteger(next)) throw new RangeError("Existing payment total exceeds the safe INR limit");
    return next;
  }, 0);
  const declaredPaidPaise = booking.p == null || booking.p === ""
    ? 0 : moneyToPaise(booking.p, "Existing paid total", { allowZero: true });
  if (rowSumPaise !== declaredPaidPaise) {
    const error = new Error("Existing booking paid total does not match its canonical payment rows. Reconcile the source records before posting another payment.");
    error.code = "BOOKING_PAID_TOTAL_MISMATCH";
    throw error;
  }

  if (Array.isArray(booking.payments)) {
    const counts = new Map();
    for (const row of pays) {
      const signature = paymentRowSignature(row, "Existing canonical payment");
      counts.set(signature, (counts.get(signature) || 0) + 1);
    }
    const historyCounts = new Map();
    for (const row of booking.payments) {
      const signature = paymentRowSignature(row, "Existing payment history");
      historyCounts.set(signature, (historyCounts.get(signature) || 0) + 1);
    }
    if (counts.size !== historyCounts.size ||
        [...counts].some(([signature, count]) => historyCounts.get(signature) !== count)) {
      const error = new Error("Canonical payment rows and compatibility payment history disagree. Reconcile the source records before posting another payment.");
      error.code = "BOOKING_PAYMENT_HISTORY_MISMATCH";
      throw error;
    }
  }
  return { declaredPaidPaise, rowSumPaise, historyRowCount: Array.isArray(booking.payments) ? booking.payments.length : null };
}

function samePayment(payment, { booking, amountPaise, method, reference }) {
  const recordedPaise = Number.isSafeInteger(payment.amountPaise)
    ? payment.amountPaise
    : moneyToPaise(payment.a ?? payment.amount, "Existing payment amount");
  return payment.bookingId === booking.id &&
    recordedPaise === amountPaise &&
    normalizedPaymentMethod(payment.m ?? payment.method) === normalizedPaymentMethod(method) &&
    normalizedPaymentReference(payment.r ?? payment.reference, payment.m ?? payment.method) === reference;
}

export function settlePayment({
  state,
  booking,
  amount,
  method,
  reference = "",
  source = "manual",
  idempotencyKey,
  balanceDue,
  verificationConfirmed = false,
  autoSettlementEnabled = AUTO_FOLIO_SETTLEMENT_ENABLED,
  gatewayActive = false,
  persist = () => {},
  audit = () => {},
  now = () => new Date().toISOString()
} = {}) {
  // Global read-only interlock: this intentionally blocks manual and automated
  // folio balance mutations until the accounting audit and release review pass.
  assertBalanceMutationAllowed();
  // The automatic path must fail closed before validation or any mutation.
  if (source === "auto") assertAutoFolioSettlementEnabled({
    enabled: autoSettlementEnabled,
    gatewayActive
  });
  if (!ALLOWED_SOURCES.has(source)) throw new TypeError("Unsupported payment source");
  if (verificationConfirmed !== true) {
    const error = new Error("Confirm that the payment was independently received before recording it");
    error.code = "PAYMENT_CONFIRMATION_REQUIRED";
    throw error;
  }
  if (!state || !Array.isArray(state.b)) throw new TypeError("Application state is required");
  if (!booking || !state.b.includes(booking)) throw new TypeError("Booking not found in application state");
  const bookingStatus = String(booking.st || "").toLowerCase();
  if (bookingStatus && !["res", "in", "done"].includes(bookingStatus)) {
    const error = new Error("Payments can only be recorded against arriving, in-house, or departed bookings");
    error.code = "BOOKING_NOT_SETTLEABLE";
    throw error;
  }

  const amountPaise = moneyToPaise(amount, "Payment amount");
  const value = amountPaise / 100;
  const paymentMethod = String(method || "").trim();
  if (!paymentMethod || paymentMethod.length > MAX_METHOD_LENGTH || /[\u0000-\u001f\u007f]/.test(paymentMethod)) {
    throw new TypeError("Payment method is required and must be at most " + MAX_METHOD_LENGTH + " characters");
  }

  const rawReference = normalizedReference(reference);
  const ref = normalizedPaymentReference(rawReference, paymentMethod);
  if (ref.length > MAX_REFERENCE_LENGTH || /[\u0000-\u001f\u007f]/.test(ref)) {
    throw new TypeError("Payment reference is invalid or too long");
  }
  const suppliedKey = String(idempotencyKey || "").trim();
  if (suppliedKey.length > MAX_IDEMPOTENCY_KEY_LENGTH || /[\u0000-\u001f\u007f]/.test(suppliedKey)) {
    throw new TypeError("Payment idempotency key is invalid or too long");
  }
  const key = suppliedKey || (ref && source !== "reservation_advance" ? "ref:" + ref : "");

  const allBookings = [
    ...state.b,
    ...(Array.isArray(state.cancelled) ? state.cancelled : [])
  ];
  const indexedPayments = allBookings.flatMap(item => {
    if (!item) return [];
    const canonical = Array.isArray(item.pays) ? item.pays : [];
    const history = Array.isArray(item.payments) ? item.payments : [];
    return [...canonical, ...history]
      .filter(payment => payment && typeof payment === "object" && !Array.isArray(payment))
      .map(payment => ({ booking: item, payment }));
  });

  if (key) {
    const existing = indexedPayments.find(row => row.payment.idempotencyKey === key);
    if (existing) {
      if (existing.booking !== booking) {
        const error = new Error(!suppliedKey && ref
          ? "Payment reference is already applied to another booking; review the original folio before proceeding"
          : "Idempotency key was already used for a different payment");
        error.code = !suppliedKey && ref
          ? "PAYMENT_REFERENCE_ALREADY_APPLIED"
          : "IDEMPOTENCY_KEY_CONFLICT";
        throw error;
      }
      if (!samePayment({ ...existing.payment, bookingId: existing.booking.id }, {
        booking, amountPaise, method: paymentMethod, reference: ref
      })) {
        const error = new Error("Idempotency key was already used for a different payment");
        error.code = "IDEMPOTENCY_KEY_CONFLICT";
        throw error;
      }
      return { ok: true, duplicate: true, payment: existing.payment };
    }
  }

  // Legacy rows do not have idempotencyKey. Preserve global UTR/reference
  // deduplication so one bank credit cannot be applied to two guest folios.
  if (ref && source !== "reservation_advance") {
    const existing = indexedPayments.find(row =>
      normalizedPaymentReference(row.payment.r ?? row.payment.reference, row.payment.m ?? row.payment.method) === ref
    );
    if (existing) {
      if (existing.booking !== booking) {
        const error = new Error("Payment reference is already applied to another booking; review the original folio before proceeding");
        error.code = "PAYMENT_REFERENCE_ALREADY_APPLIED";
        throw error;
      }
      if (moneyToPaise(existing.payment.a ?? existing.payment.amount, "Existing payment amount") !== amountPaise ||
          normalizedPaymentMethod(existing.payment.m ?? existing.payment.method) !== normalizedPaymentMethod(paymentMethod)) {
        const error = new Error("Payment reference was already recorded with different payment details");
        error.code = "PAYMENT_REFERENCE_CONFLICT";
        throw error;
      }
      return { ok: true, duplicate: true, payment: existing.payment };
    }
  }

  // A new payment must not extend an already inconsistent paid balance or history mirror.
  const accountingBefore = assertBookingAccountingConsistent(booking);
  // Validate the balance only for a new posting. An idempotent retry must
  // return the original result even though the original payment reduced due.
  const duePaise = moneyToPaise(balanceDue, "Balance due", { allowZero: true });
  if (amountPaise > duePaise) throw new RangeError("Payment exceeds the balance due");

  const priorPays = Array.isArray(booking.pays) ? booking.pays : [];
  const priorHistory = Array.isArray(booking.payments) ? booking.payments : [];
  const priorPaid = booking.p;
  const priorToday = state.today;
  const priorTodayPaise = priorToday == null || priorToday === ""
    ? 0 : moneyToPaise(priorToday, "Daily payment total", { allowZero: true });
  const priorAudit = Array.isArray(state.aud) ? state.aud.slice() : null;
  const timestamp = now();

  const payment = {
    a: value, amountPaise, m: paymentMethod, r: ref, at: timestamp,
    auto: source === "auto", source, bookingId: booking.id,
    verificationConfirmed: true, idempotencyKey: key || undefined
  };
  const history = {
    date: timestamp, amount: value, amountPaise, method: paymentMethod,
    reference: ref, source, bookingId: booking.id,
    verificationConfirmed: true, idempotencyKey: key || undefined
  };

  try {
    booking.pays = priorPays.slice();
    booking.pays.push(payment);

    const recordedRowsPaise = accountingBefore.rowSumPaise;
    const nextPaidPaise = recordedRowsPaise + amountPaise;
    const nextTodayPaise = priorTodayPaise + amountPaise;
    if (!Number.isSafeInteger(nextPaidPaise) || !Number.isSafeInteger(nextTodayPaise)) {
      throw new RangeError("Payment total exceeds the safe INR limit");
    }
    booking.p = nextPaidPaise / 100;

    booking.payments = priorHistory.slice();
    booking.payments.push(history);
    state.today = nextTodayPaise / 100;
    audit(source === "auto" ? "Auto payment" : "Payment",
      value + " by " + paymentMethod + " · Room " + booking.room + (ref ? " · ref " + ref : ""));
    persist();
    return { ok: true, duplicate: false, payment, history };
  } catch (error) {
    booking.pays = priorPays;
    booking.p = priorPaid;
    booking.payments = priorHistory;
    state.today = priorToday;
    if (priorAudit && Array.isArray(state.aud)) state.aud.splice(0, state.aud.length, ...priorAudit);
    try { persist(); } catch (_) {}
    throw error;
  }
}
