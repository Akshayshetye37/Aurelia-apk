import { moneyToPaise } from "./settlement-service.mjs";

function toPaise(value, label, { allowZero = true } = {}) {
  if (value == null || value === "") return allowZero ? 0 : null;
  return moneyToPaise(value, label, { allowZero });
}

const keyPart = value => String(value ?? "").trim();
const normalizedReference = row => {
  const reference = keyPart(row.r ?? row.reference);
  const method = String(row.m ?? row.method ?? "");
  return /upi|bank|neft|rtgs|imps|card|wallet/i.test(method)
    ? reference.replace(/\\s+/g, "").toUpperCase()
    : reference;
};

function paymentFingerprints(row) {
  const result = [];
  const key = keyPart(row.idempotencyKey);
  const reference = normalizedReference(row);
  if (key) result.push("key:" + key);
  if (reference) result.push("ref:" + reference);
  return result;
}

function rowAmountPaise(row, label) {
  const hasMinor = Number.isSafeInteger(row.amountPaise);
  const hasMajor = row.a != null || row.amount != null;
  const majorPaise = hasMajor
    ? toPaise(row.a ?? row.amount, label, { allowZero: false })
    : null;
  if (hasMinor && row.amountPaise <= 0) {
    throw new RangeError(label + " must be a positive safe integer in paise");
  }
  if (hasMinor && hasMajor && row.amountPaise !== majorPaise) {
    throw new RangeError(label + " major-unit and paise values disagree");
  }
  const amount = hasMinor ? row.amountPaise : majorPaise;
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new RangeError(label + " must be a positive safe integer in paise");
  }
  return amount;
}

function rowSignature(row) {
  return JSON.stringify([
    rowAmountPaise(row, "History payment amount"),
    keyPart(row.m ?? row.method).toLowerCase(),
    normalizedReference(row),
    keyPart(row.source),
    keyPart(row.bookingId),
    keyPart(row.idempotencyKey)
  ]);
}

/**
 * Read-only diagnostic for local PMS accounting.
 *
 * booking.pays is treated as the current canonical payment-row representation
 * for comparison purposes; booking.p and booking.payments are independently
 * checked compatibility representations. The diagnostic never chooses a
 * historical winner, mutates state, or attempts a repair.
 */
export function diagnoseAccountingConsistency(state, { worstLimit = 10 } = {}) {
  const active = Array.isArray(state?.b) ? state.b : [];
  const cancelled = Array.isArray(state?.cancelled) ? state.cancelled : [];
  const bookings = [
    ...active.map(booking => ({ booking, collection: "active" })),
    ...cancelled.map(booking => ({ booking, collection: "cancelled" }))
  ];
  const findings = [];
  const malformed = [];
  const duplicates = [];
  const orphanAdvances = [];
  const refundOverpayments = [];
  const historyMismatches = [];
  const missingBookingIds = [];
  const bookingIds = new Map();
  const paymentIndex = new Map();

  for (const { booking, collection } of bookings) {
    if (!booking || typeof booking !== "object" || Array.isArray(booking)) {
      malformed.push({ bookingId: null, collection, reason: "booking_not_object" });
      continue;
    }

    const bookingId = booking.id ?? null;
    if (bookingId == null || keyPart(bookingId) === "") {
      missingBookingIds.push({ collection, room: booking.room ?? null, reason: "booking_id_missing" });
    } else {
      const id = keyPart(bookingId);
      const rows = bookingIds.get(id) || [];
      rows.push(collection);
      bookingIds.set(id, rows);
    }

    const canonicalRows = booking.pays == null ? [] : booking.pays;
    if (!Array.isArray(canonicalRows)) {
      malformed.push({ bookingId, collection, reason: "pays_not_array" });
      continue;
    }

    let rowSumPaise = 0;
    let hasInvalidCanonicalRow = false;
    const canonicalSignatures = [];
    const localFingerprints = new Map();

    for (let index = 0; index < canonicalRows.length; index += 1) {
      const row = canonicalRows[index];
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        hasInvalidCanonicalRow = true;
        malformed.push({ bookingId, collection, rowIndex: index, reason: "payment_row_not_object" });
        continue;
      }

      try {
        const amountPaise = rowAmountPaise(row, "Payment row amount");
        rowSumPaise += amountPaise;
        if (!Number.isSafeInteger(rowSumPaise)) {
          throw new RangeError("Payment row total exceeds safe integer range");
        }
        canonicalSignatures.push(rowSignature(row));

        if (row.bookingId != null && bookingId != null &&
            keyPart(row.bookingId) !== keyPart(bookingId)) {
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

        for (const fingerprint of paymentFingerprints(row)) {
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
          const indexed = paymentIndex.get(fingerprint) || [];
          indexed.push({ bookingId, collection, rowIndex: index });
          paymentIndex.set(fingerprint, indexed);
        }
      } catch (error) {
        hasInvalidCanonicalRow = true;
        malformed.push({
          bookingId, collection, rowIndex: index,
          reason: "invalid_payment_row: " + error.message
        });
      }
    }

    let declaredPaidPaise;
    try {
      declaredPaidPaise = toPaise(booking.p, "Booking paid total");
    } catch (error) {
      malformed.push({ bookingId, collection, reason: "invalid_declared_paid_total: " + error.message });
      continue;
    }

    // Never compare an incomplete row sum with the declared paid total.
    if (!hasInvalidCanonicalRow && rowSumPaise !== declaredPaidPaise) {
      findings.push({
        bookingId, room: booking.room ?? null, status: booking.st ?? null, collection,
        declaredPaidPaise, rowSumPaise, deltaPaise: declaredPaidPaise - rowSumPaise,
        hasLegacyPayments: Array.isArray(booking.payments) && booking.payments.length > 0,
        paymentRowCount: canonicalRows.length
      });
    }

    if (booking.payments != null && !Array.isArray(booking.payments)) {
      malformed.push({ bookingId, collection, reason: "payments_not_array" });
    } else if (Array.isArray(booking.payments)) {
      const historyCounts = new Map();
      for (let index = 0; index < booking.payments.length; index += 1) {
        const row = booking.payments[index];
        if (!row || typeof row !== "object" || Array.isArray(row)) {
          malformed.push({ bookingId, collection, rowIndex: index, reason: "history_payment_row_not_object" });
          continue;
        }
        try {
          const signature = rowSignature(row);
          historyCounts.set(signature, (historyCounts.get(signature) || 0) + 1);
        } catch (error) {
          malformed.push({
            bookingId, collection, rowIndex: index,
            reason: "invalid_history_payment_row: " + error.message
          });
        }
      }
      const canonicalCounts = new Map();
      for (const signature of canonicalSignatures) {
        canonicalCounts.set(signature, (canonicalCounts.get(signature) || 0) + 1);
      }
      let missingFromHistoryCount = 0;
      let extraInHistoryCount = 0;
      for (const [signature, count] of canonicalCounts) {
        missingFromHistoryCount += Math.max(0, count - (historyCounts.get(signature) || 0));
      }
      for (const [signature, count] of historyCounts) {
        extraInHistoryCount += Math.max(0, count - (canonicalCounts.get(signature) || 0));
      }
      if (missingFromHistoryCount || extraInHistoryCount) {
        historyMismatches.push({
          bookingId, collection,
          canonicalPaymentCount: canonicalSignatures.length,
          historyPaymentCount: booking.payments.length,
          missingFromHistoryCount, extraInHistoryCount
        });
      }
    }

    const refundValue = booking.refund_amount ?? booking.refundAmount;
    if (refundValue != null && refundValue !== "") {
      const originalValue = booking.original_amount_paid ?? booking.originalAmountPaid;
      if (hasInvalidCanonicalRow && (originalValue == null || originalValue === "")) {
        malformed.push({
          bookingId, collection,
          reason: "refund_original_amount_unverifiable_due_to_invalid_payment_rows"
        });
      } else {
        try {
          const refundPaise = toPaise(refundValue, "Refund amount");
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
  }

  const duplicateBookingIds = [];
  for (const [bookingId, collections] of bookingIds) {
    if (collections.length > 1) {
      duplicateBookingIds.push({
        bookingId, occurrenceCount: collections.length, collections,
        reason: "booking_id_reused"
      });
    }
  }

  for (const [fingerprint, rows] of paymentIndex) {
    const distinctBookings = new Set(rows.map(row =>
      row.bookingId == null ? "<missing>" : keyPart(row.bookingId)
    ));
    if (distinctBookings.size > 1) {
      duplicates.push({
        fingerprint, bookingIds: [...distinctBookings], rows,
        reason: fingerprint.startsWith("ref:")
          ? "payment_reference_reused_across_bookings"
          : "payment_idempotency_key_reused_across_bookings"
      });
    }
  }

  const totalAbsoluteDiscrepancyPaise = findings.reduce(
    (sum, item) => sum + Math.abs(item.deltaPaise), 0
  );
  const worst = findings.slice()
    .sort((a, b) => Math.abs(b.deltaPaise) - Math.abs(a.deltaPaise))
    .slice(0, Math.max(0, Math.floor(worstLimit)));

  return {
    scannedBookingCount: bookings.length,
    affectedBookingCount: findings.length,
    malformedBookingCount: malformed.length,
    duplicatePaymentCount: duplicates.length,
    orphanAdvanceCount: orphanAdvances.length,
    refundOverpaymentCount: refundOverpayments.length,
    historyMismatchCount: historyMismatches.length,
    missingBookingIdCount: missingBookingIds.length,
    duplicateBookingIdCount: duplicateBookingIds.length,
    totalAbsoluteDiscrepancyPaise,
    findings, worst, malformed, duplicates, orphanAdvances, refundOverpayments,
    historyMismatches, missingBookingIds, duplicateBookingIds
  };
}
