const MONEY_TOLERANCE = 1e-7;

function amountToPaise(value) {
  const validType = typeof value === "number" ||
    (typeof value === "string" && /^\d+(?:\.\d{1,2})?$/.test(value.trim()));
  const amount = validType ? Number(value) : Number.NaN;
  if (!Number.isFinite(amount) || amount < 0) return null;
  const scaled = amount * 100;
  const paise = Math.round(scaled);
  if (!Number.isSafeInteger(paise) || Math.abs(scaled - paise) > MONEY_TOLERANCE) return null;
  return paise;
}

function paymentRowPaise(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const hasMinor = row.amountPaise !== undefined && row.amountPaise !== null;
  const hasMajor = row.a !== undefined && row.a !== null ||
    row.amount !== undefined && row.amount !== null ||
    row.value !== undefined && row.value !== null;
  const minor = hasMinor && Number.isSafeInteger(row.amountPaise) && row.amountPaise > 0
    ? row.amountPaise : null;
  if (hasMinor && minor === null) return null;
  const majorValue = row.a ?? row.amount ?? row.value;
  const major = hasMajor ? amountToPaise(majorValue) : null;
  if (hasMajor && (major === null || major <= 0)) return null;
  if (minor !== null && major !== null && minor !== major) return null;
  const result = minor ?? major;
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

function paymentRowsPaise(rows) {
  if (!Array.isArray(rows)) return null;
  let total = 0;
  for (const row of rows) {
    const amount = paymentRowPaise(row);
    if (amount === null) return null;
    total += amount;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

/**
 * Returns the original paid amount only when every available paid
 * representation agrees exactly in integer paise. Returns null when the
 * cancellation amount cannot be established safely. Never guesses by taking
 * the largest of conflicting historical fields.
 */
export function cancellationPaidAmount(booking) {
  if (!booking || typeof booking !== "object" || Array.isArray(booking)) return null;

  const totals = [];
  for (const field of ["pays", "payments", "paymentSnapshot"]) {
    const rows = booking[field];
    if (rows === undefined || rows === null) continue;
    if (!Array.isArray(rows)) return null;
    const total = paymentRowsPaise(rows);
    if (total === null) return null;
    totals.push(total);
  }

  const declared = [];
  for (const field of ["p", "original_amount_paid", "originalAmountPaid"]) {
    const value = booking[field];
    if (value === undefined || value === null || value === "") continue;
    const amount = amountToPaise(value);
    if (amount === null) return null;
    declared.push(amount);
  }

  if (totals.length === 0) {
    if (declared.every(value => value === 0)) return 0;
    return null;
  }

  const expected = totals[0];
  if (totals.some(value => value !== expected) || declared.some(value => value !== expected)) {
    return null;
  }
  return expected / 100;
}


function cancellationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Produces balanced, integer-paise cancellation journal lines.
 *
 * A pending refund may be settled in one verified payment event only. Partial
 * instalments against one pending liability are deliberately rejected until a
 * cumulative refund-event ledger is implemented.
 */
export function buildCancellationJournal({
  action,
  paidPaise,
  refundPaise,
  pendingLiabilityPaise = 0
} = {}) {
  for (const [label, value] of [
    ["Original paid amount", paidPaise],
    ["Refund amount", refundPaise],
    ["Pending refund liability", pendingLiabilityPaise]
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw cancellationError("INVALID_CANCELLATION_AMOUNT", label + " must be a non-negative integer in paise.");
    }
  }
  if (refundPaise > paidPaise) {
    throw cancellationError("REFUND_EXCEEDS_ORIGINAL_PAID", "Refund cannot exceed the verified original paid amount.");
  }

  const lines = [];
  const retainedPaise = paidPaise - refundPaise;
  if (action === "no_refund") {
    if (refundPaise !== 0) {
      throw cancellationError("NO_REFUND_AMOUNT_MUST_BE_ZERO", "Set refund to zero for No refund.");
    }
    if (pendingLiabilityPaise > 0) {
      throw cancellationError("PENDING_REFUND_MUST_BE_SETTLED", "A pending refund liability already exists and cannot be cancelled as no-refund.");
    }
    if (paidPaise > 0) {
      lines.push(
        { account: "Guest Advances Liability", debitPaise: paidPaise, creditPaise: 0 },
        { account: "Cancellation Revenue", debitPaise: 0, creditPaise: paidPaise }
      );
    }
    return { action, kind: "cancellation_settlement", lines, retainedPaise, pendingRecorded: false, committed: true };
  }

  if (action === "pending") {
    if (refundPaise <= 0) {
      throw cancellationError("PENDING_REFUND_MUST_BE_POSITIVE", "Enter a positive refund amount before creating a pending refund.");
    }
    if (pendingLiabilityPaise > 0) {
      throw cancellationError("PENDING_REFUND_ALREADY_EXISTS", "A pending refund liability already exists. Do not post it again.");
    }
    lines.push(
      { account: "Guest Advances Liability", debitPaise: refundPaise, creditPaise: 0 },
      { account: "Refunds Payable Liability", debitPaise: 0, creditPaise: refundPaise }
    );
    return { action, kind: "refund_pending", lines, retainedPaise, pendingRecorded: true, committed: false };
  }

  if (action !== "partial" && action !== "full") {
    throw cancellationError("UNSUPPORTED_REFUND_ACTION", "Unsupported cancellation refund action.");
  }
  if (refundPaise <= 0) {
    throw cancellationError("REFUND_MUST_BE_POSITIVE", "A paid refund must be greater than zero.");
  }
  if (action === "full" && refundPaise !== paidPaise) {
    throw cancellationError("FULL_REFUND_MISMATCH", "Full refund must equal the verified original paid amount.");
  }
  if (action === "partial" && refundPaise >= paidPaise) {
    throw cancellationError("PARTIAL_REFUND_MISMATCH", "Partial refund must be less than the verified original paid amount.");
  }
  if (pendingLiabilityPaise > 0 && refundPaise !== pendingLiabilityPaise) {
    throw cancellationError("PENDING_REFUND_SETTLEMENT_MISMATCH", "Set the amount to the complete verified pending refund liability. Instalment settlement is not enabled.");
  }

  lines.push(
    {
      account: pendingLiabilityPaise > 0 ? "Refunds Payable Liability" : "Guest Advances Liability",
      debitPaise: refundPaise,
      creditPaise: 0
    },
    { account: "Cash & Bank", debitPaise: 0, creditPaise: refundPaise }
  );
  if (retainedPaise > 0) {
    lines.push(
      { account: "Guest Advances Liability", debitPaise: retainedPaise, creditPaise: 0 },
      { account: "Cancellation Revenue", debitPaise: 0, creditPaise: retainedPaise }
    );
  }
  return {
    action,
    kind: pendingLiabilityPaise > 0 ? "refund_paid_and_retention" : "cancellation_settlement",
    lines,
    retainedPaise,
    pendingRecorded: false,
    committed: true
  };
}
