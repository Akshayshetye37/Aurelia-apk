const MONEY_TOLERANCE = 1e-7;

function amountToPaise(value) {
  const validType = typeof value === "number" ||
    (typeof value === "string" && /^\\d+(?:\\.\\d{1,2})?$/.test(value.trim()));
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
