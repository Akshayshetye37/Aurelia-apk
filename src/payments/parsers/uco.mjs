import { buildCreditEvent, normalizeReference } from "./common.mjs";

/** Observed UCO format: A/c ... Credited with Rs... on date by UCO-UPI. */
export function parseUcoCreditSms(raw, options = {}) {
  const text = String(raw || "").trim();
  const amountMatch = text.match(/\bCredited\s+(?:with\s+)?(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i);
  const dateMatch = text.match(/\bon\s+(\d{1,2}[-/]\d{1,2}[-/]\d{2,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)/i);
  const utrMatch = text.match(/(?:UPI\s+Ref(?:erence)?\s*(?:No\.?)?|Ref\s*No\.?|RRN\s*[:#]?)\s*([A-Z0-9]{6,})/i);
  const accountMatch = text.match(/A\/c\s+([Xx*\d]*\d{2,4})/i);
  if (!amountMatch || !/\bUCO-UPI\b|\bUPI\b/i.test(text) || !/\bcredit(?:ed)?\b/i.test(text)) {
    return { ok: false, reason: "uco_not_recognized_upi_credit" };
  }
  return buildCreditEvent("UCO", text, options, {
    amount: amountMatch[1], dateTime: dateMatch?.[1] || null,
    utr: normalizeReference(utrMatch?.[1]), accountSuffix: accountMatch?.[1] || null,
    payerName: null, upiId: null,
  });
}
