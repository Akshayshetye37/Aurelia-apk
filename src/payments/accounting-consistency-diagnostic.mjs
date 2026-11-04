import { moneyToPaise } from "./settlement-service.mjs";

function toPaise(value, label, { allowZero = true } = {}) {
  if (value == null || value === "") return allowZero ? 0 : null;
  return moneyToPaise(value, label, { allowZero });
}

/**
 * Read-only comparison of stored booking.p against canonical booking.pays rows.
 * Invalid records are reported separately and never silently coerced.
 */
export function diagnoseAccountingConsistency(state, { worstLimit = 10 } = {}) {
  const active = Array.isArray(state?.b) ? state.b : [];
  const cancelled = Array.isArray(state?.cancelled) ? state.cancelled : [];
  const findings = [];
  const malformed = [];
  const bookings = [
    ...active.map((booking) => ({ booking, collection: "active" })),
    ...cancelled.map((booking) => ({ booking, collection: "cancelled" }))
  ];

  for (const { booking, collection } of bookings) {
    if (!booking || typeof booking !== "object" || Array.isArray(booking)) {
      malformed.push({ bookingId: null, collection, reason: "booking_not_object" });
      continue;
    }

    const bookingId = booking.id ?? null;
    const rows = booking.pays == null ? [] : booking.pays;
    if (!Array.isArray(rows)) {
      malformed.push({ bookingId, collection, reason: "pays_not_array" });
      continue;
    }

    let rowSumPaise = 0;
    let invalidReason = null;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        invalidReason = "payment_row_not_object";
        break;
      }
      try {
        const amountPaise = Number.isSafeInteger(row.amountPaise)
          ? row.amountPaise
          : toPaise(row.a ?? row.amount, "Payment row amount", { allowZero: false });
        if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
          throw new RangeError("Payment row amount must be a positive safe integer in paise");
        }
        rowSumPaise += amountPaise;
        if (!Number.isSafeInteger(rowSumPaise)) throw new RangeError("Payment row total exceeds safe integer range");
      } catch (error) {
        invalidReason = "invalid_payment_row_" + index + ": " + error.message;
        break;
      }
    }

    let declaredPaidPaise;
    try {
      declaredPaidPaise = toPaise(booking.p, "Booking paid total");
    } catch (error) {
      malformed.push({ bookingId, collection, reason: "invalid_declared_paid_total: " + error.message });
      continue;
    }

    if (invalidReason) {
      malformed.push({ bookingId, collection, reason: invalidReason });
      continue;
    }

    const deltaPaise = declaredPaidPaise - rowSumPaise;
    if (deltaPaise !== 0) {
      findings.push({
        bookingId,
        room: booking.room ?? null,
        status: booking.st ?? null,
        collection,
        declaredPaidPaise,
        rowSumPaise,
        deltaPaise,
        hasLegacyPayments: Array.isArray(booking.payments) && booking.payments.length > 0,
        paymentRowCount: rows.length
      });
    }
  }

  const totalAbsoluteDiscrepancyPaise = findings.reduce(
    (sum, item) => sum + Math.abs(item.deltaPaise), 0
  );
  const worst = findings
    .slice()
    .sort((a, b) => Math.abs(b.deltaPaise) - Math.abs(a.deltaPaise))
    .slice(0, Math.max(0, Math.floor(worstLimit)));

  return {
    scannedBookingCount: bookings.length,
    affectedBookingCount: findings.length,
    malformedBookingCount: malformed.length,
    totalAbsoluteDiscrepancyPaise,
    findings,
    worst,
    malformed
  };
}
