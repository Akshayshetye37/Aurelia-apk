/**
 * Single mutation boundary for hotel folio payments.
 * The app state is currently local HTML/JS storage; this service provides
 * in-memory rollback on thrown persistence errors but is not a cross-store DB transaction.
 */
const ALLOWED_SOURCES = new Set(["manual", "staff_review", "reservation_advance", "auto"]);

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
  assertAutoFolioSettlementEnabled = () => {
    throw new Error("Automatic folio settlement is disabled");
  },
  now = () => new Date().toISOString()
} = {}) {
  // The automatic path must fail closed before validation or any mutation.
  if (source === "auto") assertAutoFolioSettlementEnabled();
  if (!ALLOWED_SOURCES.has(source)) throw new TypeError("Unsupported payment source");
  if (!state || !Array.isArray(state.b)) throw new TypeError("Application state is required");
  if (!booking || !state.b.includes(booking)) throw new TypeError("Booking not found in application state");

  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) throw new RangeError("Payment amount must be greater than zero");
  const paymentMethod = String(method || "").trim();
  if (!paymentMethod) throw new TypeError("Payment method is required");

  const ref = String(reference || "").trim();
  const key = String(idempotencyKey || "").trim() || (ref && source !== "reservation_advance" ? "ref:" + ref : "");
  const allPayments = state.b.flatMap(item => Array.isArray(item.pays) ? item.pays : []);

  if (key && allPayments.some(payment => payment.idempotencyKey === key)) {
    return { ok: true, duplicate: true, payment: allPayments.find(payment => payment.idempotencyKey === key) };
  }
  // Legacy rows do not have idempotencyKey. Preserve UTR/reference dedupe across bookings.
  if (ref && source !== "reservation_advance" && allPayments.some(payment => String(payment.r || "").trim() === ref)) {
    return { ok: true, duplicate: true, payment: allPayments.find(payment => String(payment.r || "").trim() === ref) };
  }

  const due = Number(balanceDue);
  if (Number.isFinite(due) && value > due + 0.001) {
    throw new RangeError("Payment exceeds the balance due");
  }

  const priorPays = Array.isArray(booking.pays) ? booking.pays : [];
  const priorHistory = Array.isArray(booking.payments) ? booking.payments : [];
  const priorPaid = booking.p;
  const priorToday = state.today;
  const priorAudit = Array.isArray(state.aud) ? state.aud.slice() : null;
  const timestamp = now();
  const payment = { a: value, m: paymentMethod, r: ref, at: timestamp, auto: source === "auto", source, idempotencyKey: key || undefined };
  const history = { date: timestamp, amount: value, method: paymentMethod, reference: ref, source, idempotencyKey: key || undefined };

  try {
    booking.pays = priorPays.slice();
    booking.pays.push(payment);
    booking.p = booking.pays.reduce((sum, row) => sum + (Number(row.a) || 0), 0);
    booking.payments = priorHistory.slice();
    booking.payments.push(history);
    state.today = (Number(state.today) || 0) + value;
    audit(source === "auto" ? "Auto payment" : "Payment", value + " by " + paymentMethod + " · Room " + booking.room + (ref ? " · ref " + ref : ""));
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
