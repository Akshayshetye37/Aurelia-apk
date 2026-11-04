import { moneyToPaise } from "./settlement-service.mjs";

function toPaise(value, label, { allowZero = true } = {}) {
  if (value == null || value === "") return allowZero ? 0 : null;
  return moneyToPaise(value, label, { allowZero });
}

function normalizedKey(value) {
  return String(value ?? "").trim();
}

function paymentFingerprint(row) {
  const key = normalizedKey(row.idempotencyKey);
  if (key) return "key:" + key;
  const reference = normalizedKey(row.r ?? row.reference).replace(/\\s+/g, "").toUpperCase();
  if (reference) return "ref:" + reference;
  return null;
}

/**
 * Read-only diagnostic for local PMS accounting.
 *
 * It intentionally does not decide which historical representation is
 * authoritative and never repairs or persists application state.
 */
export function diagnoseAccountingConsistency(state, { worstLimit = 10 } = {}) {
  const active = Array.isArray(state?.b) ? state.b : [];
  const cancelled = Array.isArray(state?.cancelled) ? state.cancelled : [];
  const findings = [];
  const malformed = [];
  const duplicates = [];
  const orphanAdvances = [];
  const refundOverpayments = [];
  const paymentIndex = new Map();
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
    const localFingerprints = new Map();
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
        if (!Number.isSafeInteger(rowSumPaise)) {
          throw new RangeError("Payment row total exceeds safe integer range");
        }

        if (row.bookingId != null && bookingId != null &&
            String(row.bookingId) !== String(bookingId)) {
          orphanAdvances.push({
            bookingId, collection, rowIndex: index,
            paymentBookingId: row.bookingId,
            reason: "payment_booking_id_mismatch"
          });
        }
        if (row.source === "reservation_advance") {
          const expectedKey = bookingId == null ? null : "booking-advance:" + bookingId;
          if (!expectedKey || row.idempotencyKey !== expectedKey) {
            orphanAdvances.push({
              bookingId, collection, rowIndex: index,
              idempotencyKey: row.idempotencyKey ?? null,
              reason: "reservation_advance_key_mismatch"
            });
          }
        }

        const fingerprint = paymentFingerprint(row);
        if (fingerprint) {
          const previous = localFingerprints.get(fingerprint);
          if (previous !== undefined) {
            duplicates.push({
              fingerprint, bookingId, collection,
              firstRowIndex: previous, duplicateRowIndex: index,
              reason: "duplicate_payment_within_booking"
            });
          } else {
            localFingerprints.set(fingerprint, index);
          }
          const globalRows = paymentIndex.get(fingerprint) || [];
          globalRows.push({ bookingId, collection, rowIndex: index });
          paymentIndex.set(fingerprint, globalRows);
        }
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

    const refundValue = booking.refund_amount ?? booking.refundAmount;
    if (refundValue != null && refundValue !== "") {
      try {
        const refundPaise = toPaise(refundValue, "Refund amount");
        const originalValue = booking.original_amount_paid ?? booking.originalAmountPaid;
        const originalPaidPaise = originalValue == null || originalValue === ""
          ? Math.max(declaredPaidPaise, rowSumPaise)
          : toPaise(originalValue, "Original amount paid");
        if (refundPaise > originalPaidPaise) {
          refundOverpayments.push({
            bookingId, collection, refundPaise, originalPaidPaise,
            excessPaise: refundPaise - originalPaidPaise,
            reason: "refund_exceeds_recorded_payment"
          });
        }
      } catch (error) {
        malformed.push({ bookingId, collection, reason: "invalid_refund_amount: " + error.message });
      }
    }
  }

  for (const [fingerprint, rows] of paymentIndex) {
    const distinctBookings = new Set(rows.map(row => String(row.bookingId)));
    if (distinctBookings.size > 1) {
      duplicates.push({
        fingerprint, bookingIds: [...distinctBookings],
        rows, reason: "payment_reference_reused_across_bookings"
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
    duplicatePaymentCount: duplicates.length,
    orphanAdvanceCount: orphanAdvances.length,
    refundOverpaymentCount: refundOverpayments.length,
    totalAbsoluteDiscrepancyPaise,
    findings,
    worst,
    malformed,
    duplicates,
    orphanAdvances,
    refundOverpayments
  };
}
