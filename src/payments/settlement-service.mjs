import { assertAutoFolioSettlementEnabled } from "./settlement-gate.mjs";

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

function moneyToPaise(value, label, { allowZero = false } = {}) {
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

function samePayment(payment, { booking, amountPaise, method, reference }) {
  const recordedPaise = Number.isSafeInteger(payment.amountPaise)
    ? payment.amountPaise
    : moneyToPaise(payment.a ?? payment.amount, "Existing payment amount");
  return payment.bookingId === booking.id &&
    recordedPaise === amountPaise &&
    String(payment.m || payment.method || "").trim() === method &&
    normalizedReference(payment.r ?? payment.reference) === reference;
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
  persist = () => {},
  audit = () => {},
  now = () => new Date().toISOString()
} = {}) {
  // The automatic path must fail closed before validation or any mutation.
  if (source === "auto") assertAutoFolioSettlementEnabled();
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

  const ref = normalizedReference(reference);
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
      normalizedReference(row.payment.r ?? row.payment.reference) === ref
    );
    if (existing) {
      if (existing.booking !== booking) {
        const error = new Error("Payment reference is already applied to another booking; review the original folio before proceeding");
        error.code = "PAYMENT_REFERENCE_ALREADY_APPLIED";
        throw error;
      }
      if (moneyToPaise(existing.payment.a ?? existing.payment.amount, "Existing payment amount") !== amountPaise) {
        const error = new Error("Payment reference was already recorded with a different amount");
        error.code = "PAYMENT_REFERENCE_CONFLICT";
        throw error;
      }
      return { ok: true, duplicate: true, payment: existing.payment };
    }
  }

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

    // Older installations may have a paid total without corresponding
    // canonical payment rows. Preserve that recorded balance instead of
    // silently reducing it when the first new payment is entered.
    const recordedRowsPaise = priorPays.reduce((sum, row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw new TypeError("Existing payment row is invalid");
      }
      const rowPaise = Number.isSafeInteger(row.amountPaise)
        ? row.amountPaise
        : moneyToPaise(row.a ?? row.amount, "Existing payment amount");
      if (rowPaise <= 0) throw new RangeError("Existing payment amount must be greater than zero");
      const total = sum + rowPaise;
      if (!Number.isSafeInteger(total)) throw new RangeError("Existing payment total exceeds the safe INR limit");
      return total;
    }, 0);
    const legacyPaidPaise = priorPaid == null || priorPaid === ""
      ? 0 : moneyToPaise(priorPaid, "Existing paid total", { allowZero: true });
    const nextPaidPaise = Math.max(recordedRowsPaise, legacyPaidPaise) + amountPaise;
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
