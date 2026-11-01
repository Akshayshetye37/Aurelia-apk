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
  const amount = Number(value);
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
  return payment.bookingId === booking.id &&
    Number.isSafeInteger(payment.amountPaise) && payment.amountPaise === amountPaise &&
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
  persist = () => {},
  audit = () => {},
  now = () => new Date().toISOString()
} = {}) {
  // The automatic path must fail closed before validation or any mutation.
  if (source === "auto") assertAutoFolioSettlementEnabled();
  if (!ALLOWED_SOURCES.has(source)) throw new TypeError("Unsupported payment source");
  if (!state || !Array.isArray(state.b)) throw new TypeError("Application state is required");
  if (!booking || !state.b.includes(booking)) throw new TypeError("Booking not found in application state");

  const amountPaise = moneyToPaise(amount, "Payment amount");
  const value = amountPaise / 100;
  const paymentMethod = String(method || "").trim();
  if (!paymentMethod || paymentMethod.length > MAX_METHOD_LENGTH) {
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

  // Validate the balance before mutation. A missing/invalid balance must not
  // silently disable the overpayment guard.
  const duePaise = moneyToPaise(balanceDue, "Balance due", { allowZero: true });
  if (amountPaise > duePaise) throw new RangeError("Payment exceeds the balance due");

  const indexedPayments = state.b.flatMap(item =>
    (Array.isArray(item.pays) ? item.pays : []).map(payment => ({ booking: item, payment }))
  );

  if (key) {
    const existing = indexedPayments.find(row => row.payment.idempotencyKey === key);
    if (existing) {
      if (existing.booking !== booking ||
          !samePayment({ ...existing.payment, bookingId: existing.booking.id }, {
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
      if (existing.booking === booking &&
          moneyToPaise(existing.payment.a ?? existing.payment.amount, "Existing payment amount") !== amountPaise) {
        const error = new Error("Payment reference was already recorded with a different amount");
        error.code = "PAYMENT_REFERENCE_CONFLICT";
        throw error;
      }
      return { ok: true, duplicate: true, payment: existing.payment };
    }
  }

  const priorPays = Array.isArray(booking.pays) ? booking.pays : [];
  const priorHistory = Array.isArray(booking.payments) ? booking.payments : [];
  const priorPaid = booking.p;
  const priorPaidNumeric = Number(priorPaid);
  const priorToday = state.today;
  const priorAudit = Array.isArray(state.aud) ? state.aud.slice() : null;
  const timestamp = now();

  const payment = {
    a: value, amountPaise, m: paymentMethod, r: ref, at: timestamp,
    auto: source === "auto", source, bookingId: booking.id,
    idempotencyKey: key || undefined
  };
  const history = {
    date: timestamp, amount: value, amountPaise, method: paymentMethod,
    reference: ref, source, bookingId: booking.id, idempotencyKey: key || undefined
  };

  try {
    booking.pays = priorPays.slice();
    booking.pays.push(payment);

    // Older installations may have a paid total without corresponding
    // canonical payment rows. Preserve that recorded balance instead of
    // silently reducing it when the first new payment is entered.
    const recordedRowsPaise = priorPays.reduce((sum, row) => {
      const rowPaise = Number.isSafeInteger(row.amountPaise)
        ? row.amountPaise
        : moneyToPaise(Number(row.a) || 0, "Existing payment amount", { allowZero: true });
      return sum + rowPaise;
    }, 0);
    const legacyPaidPaise = Number.isFinite(priorPaidNumeric) && priorPaidNumeric > 0
      ? moneyToPaise(priorPaidNumeric, "Existing paid total", { allowZero: true })
      : 0;
    booking.p = (Math.max(recordedRowsPaise, legacyPaidPaise) + amountPaise) / 100;

    booking.payments = priorHistory.slice();
    booking.payments.push(history);
    state.today = (Number(state.today) || 0) + value;
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
