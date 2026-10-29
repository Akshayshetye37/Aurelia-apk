import { createPaymentEvent, parseAmountToPaise } from "../payment-engine.mjs";

/**
 * Shared, conservative helpers for bank SMS parsers.
 * Bank SMS local timestamps are interpreted as India Standard Time (IST).
 */
export function parseIndianDateTime(raw) {
  if (!raw) return { timestamp: null, precision: "unknown" };
  const value = String(raw).trim();
  let m;
  let y, month, day, hour = 0, minute = 0, second = 0, hasTime = false;

  if ((m = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i))) {
    [, y, month, day] = m;
    if (m[4] !== undefined) {
      hour = Number(m[4]); minute = Number(m[5]); second = Number(m[6] || 0); hasTime = true;
      if (m[7]) hour = (hour % 12) + (m[7].toUpperCase() === "PM" ? 12 : 0);
    }
  } else if ((m = value.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i))) {
    day = m[1]; month = m[2]; y = m[3];
    if (m[4] !== undefined) {
      hour = Number(m[4]); minute = Number(m[5]); second = Number(m[6] || 0); hasTime = true;
      if (m[7]) hour = (hour % 12) + (m[7].toUpperCase() === "PM" ? 12 : 0);
    }
  } else if ((m = value.match(/^(\d{1,2})[- ]([A-Za-z]{3})[- ](\d{2,4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i))) {
    day = m[1]; month = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"].indexOf(m[2].toLowerCase()) + 1; y = m[3];
    if (m[4] !== undefined) {
      hour = Number(m[4]); minute = Number(m[5]); second = Number(m[6] || 0); hasTime = true;
      if (m[7]) hour = (hour % 12) + (m[7].toUpperCase() === "PM" ? 12 : 0);
    }
  } else {
    return { timestamp: null, precision: "unknown" };
  }

  y = Number(String(y).length === 2 ? `20${y}` : y);
  month = Number(month); day = Number(day);
  if (!Number.isInteger(y) || month < 1 || month > 12 || day < 1 || day > 31 ||
      hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    return { timestamp: null, precision: "unknown" };
  }
  const utcMs = Date.UTC(y, month - 1, day, hour, minute, second) - (5 * 60 + 30) * 60 * 1000;
  const check = new Date(utcMs + (5 * 60 + 30) * 60 * 1000);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return { timestamp: null, precision: "unknown" };
  }
  return { timestamp: new Date(utcMs).toISOString(), precision: hasTime ? "exact" : "date_only" };
}

export function buildCreditEvent(bank, raw, options, fields) {
  if (!fields.amount) return { ok: false, reason: `${bank.toLowerCase()}_credit_amount_not_found` };
  let amountPaise;
  try {
    amountPaise = parseAmountToPaise(fields.amount);
  } catch {
    return { ok: false, reason: `${bank.toLowerCase()}_credit_amount_invalid` };
  }
  const parsedDate = parseIndianDateTime(fields.dateTime);
  const event = createPaymentEvent({
    eventId: options.eventId,
    evidenceId: options.evidenceId,
    source: "bank_sms",
    eventType: "credit",
    amountPaise,
    timestamp: parsedDate.timestamp,
    timestampPrecision: parsedDate.precision,
    utr: fields.utr || null,
    payerName: fields.payerName || null,
    upiId: fields.upiId || null,
    bank,
    accountSuffix: fields.accountSuffix || null,
    rawEvidence: raw,
    receivedAt: options.receivedAt,
  });
  return { ok: true, event };
}

export function normalizeReference(value) {
  return value ? String(value).replace(/[^A-Z0-9]/gi, "").toUpperCase() : null;
}
