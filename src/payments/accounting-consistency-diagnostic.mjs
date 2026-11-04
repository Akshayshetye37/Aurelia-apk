import { moneyToPaise } from "./settlement-service.mjs";

function toPaise(value, label, { allowZero = true } = {}) {
  if (value == null || value === "") return allowZero ? 0 : null;
  return moneyToPaise(value, label, { allowZero });
}

function keyPart(value) {
  return String(value ?? "").trim();
}

function paymentFingerprints(row) {
  const keys = [];
  const idempotencyKey = keyPart(row.idempotencyKey);
  const reference = keyPart(row.r ?? row.reference).replace(/\s+/g, "").toUpperCase();
  if (idempotencyKey) keys.push("idempotency:" + idempotencyKey);
  if (reference) keys.push("reference:" + reference);
  return keys;
}

function paymentAmountPaise(row, label) {
  if (Number.isSafeInteger(row.amountPaise)) {
    if (row.amountPaise <= 0) throw new RangeError(label + " must be a positive safe integer in paise");
    return row.amountPaise;
  }
  return toPaise(row.a ?? row.amount, label, { allowZero: false });
}

function historySignature(row) {
  let amount;
  if (Number.isSafeInteger(row.amountPaise)) {
    if (row.amountPaise <= 0) throw new RangeError("History payment amount must be a positive safe integer in paise");
    amount = row.amountPaise;
  } else {
    amount = toPaise(row.a ?? row.amount, "History payment amount", { allowZero: false });
  }
  return JSON.stringify([
    amount,
    keyPart(row.m ?? row.method).toLowerCase(),
    keyPart(row.r ?? row.reference).replace(/\s+/g, "").toUpperCase(),
    keyPart(row.source),
    keyPart(row.bookingId),
    keyPart(row.idempotencyKey)
  ]);
}

/**
 * Read-only diagnostic for local PMS accounting.
 *
 * booking.pays is the settlement service's canonical payment-row collection;
 * booking.p and booking.payments are compatibility representations. The
 * diagnostic reports disagreement without selecting a historical winner,
 * mutating state, or attempting a repair.
 */
export function diagnoseAccountingConsistency(state, { worstLimit = 10 } = {}) {
  const active = Array.isArray(state?.b) ? state.b : [];
  const cancelled = Array.isArray(state?.cancelled) ? state.cancelled : [];
  const findings = [];
  const malformed = [];
  const duplicates = [];
  const orphanAdvances = [];
  const refundOverpayments = [];
  const historyMismatches = [];
  const missingBookingIds = [];
  const duplicateBookingIds = [];
  const paymentIndex = new Map();
  const bookingIdIndex = new Map();
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
    if (bookingId == null || keyPart(bookingId) === "") {
      missingBookingIds.push({ collection, room: booking.room ?? null, reason: "booking_id_missing" });
    } else {
      const idKey = keyPart(bookingId);
      const seen = bookingIdIndex.get(idKey) || [];
      seen.push(collection);
      bookingIdIndex.set(idKey, seen);
    }

    const rows = booking.pays == null ? [] : booking.pays;
    if (!Array.isArray(rows)) {
      malformed.push({ bookingId, collection, reason: "pays_not_array" });
      continue;
    }

    let rowSumPaise = 0;
    let invalidPaymentRows = false;
    const localFingerprints = new Map();
    const canonicalSignatures = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        malformed.push({ bookingId, collection, reason: "payment_row_not_object", rowIndex: index });
        continue;
      }
      try {
        const amountPaise = paymentAmountPaise(row, "Payment row amount");
        rowSumPaise += amountPaise;
        if (!Number.isSafeInteger(rowSumPaise)) throw new RangeError("Payment row total exceeds safe integer range");

        if (row.bookingId != null && bookingId != null && keyPart(row.bookingId) !== keyPart(bookingId)) {
          orphanAdvances.push({ bookingId, collection, rowIndex: index, paymentBookingId: row.bookingId, reason: "payment_booking_id_mismatch" });
        }
        if (row.source === "reservation_advance") {
          const expectedKey = bookingId == null ? null : "booking-advance:" + bookingId;
          if (!expectedKey || row.idempotencyKey !== expectedKey) {
            orphanAdvances.push({ bookingId, collection, rowIndex: index, idempotencyKey: row.idempotencyKey ?? null, reason: "reservation_advance_key_mismatch" });
          }
        }

        canonicalSignatures.push(historySignature(row));
        for (const fingerprint of paymentFingerprints(row)) {
          const previous = localFingerprints.get(fingerprint);
          if (previous !== undefined) {
            duplicates.push({ fingerprint, bookingId, collection, firstRowIndex: previous, duplicateRowIndex: index, reason: "duplicate_payment_within_booking" });
          } else {
            localFingerprints.set(fingerprint, index);
          }
          const globalRows = paymentIndex.get(fingerprint) || [];
          globalRows.push({ bookingId, collection, rowIndex: index });
          paymentIndex.set(fingerprint, globalRows);
        }
      } catch (error) {
        invalidPaymentRows = true;
        malformed.push({ bookingId, collection, rowIndex: index, reason: "invalid_payment_row: " + error.message });
      }
    }

    let declaredPaidPaise;
    try {
      declaredPaidPaise = toPaise(booking.p, "Booking paid total");
    } catch (error) {
      malformed.push({ bookingId, collection, reason: "invalid_declared_paid_total: " + error.message });
      continue;
    }

    if (!invalidPaymentRows && rowSumPaise !== declaredPaidPaise) {
      findings.push({
        bookingId, room: booking.room ?? null, status: booking.st ?? null, collection,
        declaredPaidPaise, rowSumPaise, deltaPaise: declaredPaidPaise - rowSumPaise,
        hasLegacyPayments: Array.isArray(booking.payments) && booking.payments.length > 0,
        paymentRowCount: rows.length
      });
    }

    if (booking.payments != null && !Array.isArray(booking.payments)) {
      malformed.push({ bookingId, collection, reason: "payments_not_array" });
    } else if (Array.isArray(booking.payments)) {
      const historyCounts = new Map();
      for (const row of booking.payments) {
        if (!row || typeof row !== "object" || Array.isArray(row)) {
          malformed.push({ bookingId, collection, reason: "history_payment_row_not_object" });
          continue;
        }
        try {
          const signature = historySignature(row);
          historyCounts.set(signature, (historyCounts.get(signature) || 0) + 1);
        } catch (error) {
          malformed.push({ bookingId, collection, reason: "invalid_history_payment_row: " + error.message });
        }
      }
      const canonicalCounts = new Map();
      canonicalSignatures.forEach(signature => canonicalCounts.set(signature, (canonicalCounts.get(signature) || 0) + 1));
      const missingFromHistory = [];
      const extraInHistory = [];
      for (const [signature, count] of canonicalCounts) {
        const difference = count - (historyCounts.get(signature) || 0);
        for (let i = 0; i < difference; i += 1) missingFromHistory.push(signature);
      }
      for (const [signature, count] of historyCounts) {
        const difference = count - (canonicalCounts.get(signature) || 0);
        for (let i = 0; i < difference; i += 1) extraInHistory.push(signature);
      }
      if (missingFromHistory.length || extraInHistory.length) {
        historyMismatches.push({ bookingId, collection, canonicalPaymentCount: canonicalSignatures.length, historyPaymentCount: booking.payments.length, missingFromHistoryCount: missingFromHistory.length, extraInHistoryCount: extraInHistory.length });
      }
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
          refundOverpayments.push({ bookingId, collection, refundPaise, originalPaidPaise, excessPaise: refundPaise - originalPaidPaise, reason: "refund_exceeds_recorded_payment" });
        }
      } catch (error) {
        malformed.push({ bookingId, collection, reason: "invalid_refund_amount: " + error.message });
      }
    }
  }

  for (const [bookingId, collections] of bookingIdIndex) {
    if (collections.length > 1) duplicateBookingIds.push({ bookingId, occurrenceCount: collections.length, collections, reason: "booking_id_reused" });
  }
  for (const [fingerprint, rows] of paymentIndex) {
    const distinctBookings = new Set(rows.map(row => row.bookingId == null ? "<missing>" : keyPart(row.bookingId)));
    if (distinctBookings.size > 1) {
      duplicates.push({ fingerprint, bookingIds: [...distinctBookings], rows, reason: fingerprint.startsWith("reference:") ? "payment_reference_reused_across_bookings" : "payment_idempotency_key_reused_across_bookings" });
    }
  }

  const journalMalformed = [];
  const unbalancedJournals = [];
  const duplicateJournalIds = [];
  const duplicateCancellationPostings = [];
  const cancellationFlagMismatches = [];
  const ledger = state?.financialLedger === undefined ? [] : state.financialLedger;
  const journalIds = new Map();
  const cancellationReferences = new Map();
  if (!Array.isArray(ledger)) {
    journalMalformed.push({ reason: "financial_ledger_not_array" });
  } else {
    for (let index = 0; index < ledger.length; index += 1) {
      const entry = ledger[index];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        journalMalformed.push({ entryIndex: index, reason: "journal_entry_not_object" });
        continue;
      }
      const id = keyPart(entry.id);
      const reference = keyPart(entry.reference);
      if (!id || !reference || !Array.isArray(entry.lines) || entry.lines.length === 0) {
        journalMalformed.push({ entryIndex: index, journalId: id || null, reference: reference || null, reason: "journal_identity_or_lines_missing" });
        continue;
      }
      const priorIds = journalIds.get(id) || [];
      priorIds.push(index);
      journalIds.set(id, priorIds);
      if (String(entry.kind || "").startsWith("refund_") || entry.kind === "cancellation_settlement") {
        const refs = cancellationReferences.get(reference) || [];
        refs.push({ entryIndex: index, journalId: id, kind: entry.kind || "unknown", bookingId: entry.bookingId ?? null });
        cancellationReferences.set(reference, refs);
      }
      let debitPaise = 0;
      let creditPaise = 0;
      let valid = true;
      for (let lineIndex = 0; lineIndex < entry.lines.length; lineIndex += 1) {
        const line = entry.lines[lineIndex];
        if (!line || typeof line !== "object" || Array.isArray(line) ||
            typeof line.account !== "string" || !line.account.trim() || line.account.length > 120) {
          journalMalformed.push({ entryIndex: index, journalId: id, lineIndex, reason: "journal_line_invalid" });
          valid = false;
          continue;
        }
        try {
          const debit = toPaise(line.debit ?? 0, "Journal debit");
          const credit = toPaise(line.credit ?? 0, "Journal credit");
          if (debit > 0 && credit > 0) throw new RangeError("Journal line cannot contain both debit and credit");
          debitPaise += debit;
          creditPaise += credit;
          if (!Number.isSafeInteger(debitPaise) || !Number.isSafeInteger(creditPaise)) {
            throw new RangeError("Journal total exceeds safe integer range");
          }
        } catch (error) {
          journalMalformed.push({ entryIndex: index, journalId: id, lineIndex, reason: "invalid_journal_amount: " + error.message });
          valid = false;
        }
      }
      if (valid && debitPaise !== creditPaise) {
        unbalancedJournals.push({ entryIndex: index, journalId: id, reference, debitPaise, creditPaise, deltaPaise: debitPaise - creditPaise });
      }
    }
  }
  for (const [id, indexes] of journalIds) {
    if (indexes.length > 1) duplicateJournalIds.push({ journalId: id, entryIndexes: indexes, reason: "journal_id_reused" });
  }
  for (const [reference, entries] of cancellationReferences) {
    const pending = entries.filter(entry => entry.kind === "refund_pending");
    const completed = entries.filter(entry => entry.kind !== "refund_pending");
    const bookingKeys = new Set(entries.map(entry =>
      entry.bookingId == null ? "null" : keyPart(entry.bookingId)));
    if (bookingKeys.size > 1 || pending.length > 1 || completed.length > 1) {
      duplicateCancellationPostings.push({
        reference, pendingEntryCount: pending.length, completedEntryCount: completed.length,
        bookingIds: [...bookingKeys], entryIndexes: entries.map(entry => entry.entryIndex),
        reason: bookingKeys.size > 1 ? "cancellation_reference_reused_across_bookings"
          : pending.length > 1 ? "duplicate_refund_payable_posting" : "duplicate_cancellation_settlement"
      });
    }
  }
  for (const booking of cancelled) {
    if (!booking || typeof booking !== "object" || Array.isArray(booking)) continue;
    const bookingId = booking.id ?? null;
    const related = Array.isArray(ledger)
      ? ledger.filter(entry => entry && typeof entry === "object" &&
          (bookingId == null ? entry.bookingId == null : keyPart(entry.bookingId) === keyPart(bookingId)))
      : [];
    const cancellationEntries = related.filter(entry =>
      ["refund_pending", "refund_paid_and_retention", "cancellation_settlement"].includes(entry.kind));
    if (booking.cancellationAccountingCommitted === true && cancellationEntries.length === 0) {
      cancellationFlagMismatches.push({ bookingId, reason: "committed_cancellation_without_journal" });
    }
    if (booking.refundPayableJournalRecorded === true &&
        !cancellationEntries.some(entry => entry.kind === "refund_pending")) {
      cancellationFlagMismatches.push({ bookingId, reason: "refund_payable_flag_without_pending_journal" });
    }
    const refundAmount = Number(booking.refund_amount ?? 0);
    if (refundAmount > 0 && booking.cancelledStatus === "refund_pending") {
      const pendingEntries = cancellationEntries.filter(entry => entry.kind === "refund_pending");
      if (pendingEntries.length === 0) {
        cancellationFlagMismatches.push({ bookingId, reason: "pending_refund_status_without_payable_journal" });
      } else {
        try {
          const payablePaise = pendingEntries.reduce((sum, entry) => sum +
            entry.lines.filter(line => line.account === "Refunds Payable Liability")
              .reduce((value, line) => value + toPaise(line.credit ?? 0, "Refund payable credit") -
                toPaise(line.debit ?? 0, "Refund payable debit"), 0), 0);
          if (payablePaise !== toPaise(refundAmount, "Booking pending refund")) {
            cancellationFlagMismatches.push({ bookingId, reason: "pending_refund_amount_does_not_match_liability" });
          }
          const retainedAmount = Number(booking.retention_fee_retained ??
            Math.max(0, Number(booking.original_amount_paid ?? 0) - refundAmount));
          const retainedPaise = pendingEntries.reduce((sum, entry) => sum +
            entry.lines.filter(line => line.account === "Cancellation Revenue")
              .reduce((value, line) => value + toPaise(line.credit ?? 0, "Cancellation revenue credit") -
                toPaise(line.debit ?? 0, "Cancellation revenue debit"), 0), 0);
          if (retainedPaise !== toPaise(retainedAmount, "Booking retained cancellation amount")) {
            cancellationFlagMismatches.push({ bookingId, reason: "pending_refund_retention_does_not_match_journal" });
          }
        } catch {
          cancellationFlagMismatches.push({ bookingId, reason: "pending_refund_liability_amount_invalid" });
        }
      }
    }
    if (refundAmount > 0 && ["refunded", "partially_refunded"].includes(booking.cancelledStatus)) {
      const paidEntries = cancellationEntries.filter(entry =>
        entry.kind === "refund_paid_and_retention" || entry.kind === "cancellation_settlement");
      if (paidEntries.length === 0) {
        cancellationFlagMismatches.push({ bookingId, reason: "paid_refund_status_without_settlement_journal" });
      } else {
        try {
          const paidRefundPaise = paidEntries.reduce((sum, entry) => sum +
            entry.lines.filter(line => line.account === "Cash & Bank")
              .reduce((value, line) => value + toPaise(line.credit ?? 0, "Refund cash credit") -
                toPaise(line.debit ?? 0, "Refund cash debit"), 0), 0);
          if (paidRefundPaise !== toPaise(refundAmount, "Booking paid refund")) {
            cancellationFlagMismatches.push({ bookingId, reason: "paid_refund_amount_does_not_match_journal" });
          }
        } catch {
          cancellationFlagMismatches.push({ bookingId, reason: "paid_refund_journal_amount_invalid" });
        }
      }
      if (booking.refund_settlement_confirmed !== true || !keyPart(booking.refund_transaction_reference)) {
        cancellationFlagMismatches.push({ bookingId, reason: "paid_refund_missing_settlement_evidence" });
      }
    }
  }

  const totalAbsoluteDiscrepancyPaise = findings.reduce((sum, item) => sum + Math.abs(item.deltaPaise), 0);
  const worst = findings.slice().sort((a, b) => Math.abs(b.deltaPaise) - Math.abs(a.deltaPaise))
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
    malformedJournalCount: journalMalformed.length,
    unbalancedJournalCount: unbalancedJournals.length,
    duplicateJournalIdCount: duplicateJournalIds.length,
    duplicateCancellationPostingCount: duplicateCancellationPostings.length,
    cancellationFlagMismatchCount: cancellationFlagMismatches.length,
    totalAbsoluteDiscrepancyPaise,
    findings, worst, malformed, duplicates, orphanAdvances, refundOverpayments,
    historyMismatches, missingBookingIds, duplicateBookingIds,
    journalMalformed, unbalancedJournals, duplicateJournalIds,
    duplicateCancellationPostings, cancellationFlagMismatches
  };
}
