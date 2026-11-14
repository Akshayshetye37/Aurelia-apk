import { buildCreditEvent, normalizeReference } from "./common.mjs";

/**
 * Conservative Axis parser for explicit UPI credit alerts.
 * Generic "credited to account" messages without a UPI marker are rejected.
 * Banks may suppress SMS for some UPI credits; absence of an SMS is not proof
 * that a payment did not happen.
 */
export function parseAxisCreditSms(raw, options = {}) {
  const text = String(raw || "").trim();
  const amountMatch = text.match(/(?:INR|Rs\.?|₹|Rupees)\s*([\d,]+(?:\.\d{1,2})?)\s+(?:has\s+been\s+)?credited\b/i) ||
    text.match(/credited\s+(?:with\s+)?(?:INR|Rs\.?|₹|Rupees)\s*([\d,]+(?:\.\d{1,2})?)/i);
  const dateMatch = text.match(/\bon\s+(\d{1,2}[-/]\d{1,2}[-/]\d{2,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)/i) ||
    text.match(/\bon\s+(\d{1,2}[- ][A-Za-z]{3}[- ]\d{2,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)/i);
  const utrMatch = text.match(/(?:UPI\s+Ref(?:erence)?\s*(?:No\.?)?|UPI\s*[:#]|RRN\s*[:#]?)\s*([A-Z0-9]{6,})/i);
  const vpaMatch = text.match(/(?:VPA|UPI\s*ID)\s*[:=]?\s*([A-Z0-9._-]+@[A-Z0-9.-]+)/i);
  const payerMatch = text.match(/\bfrom\s+(.+?)(?=\s*(?:\(|UPI|RRN|Avl\.?\s*Bal|Available Balance|$))/i);
  const accountMatch = text.match(/(?:A\/c|account)\s+(?:No\.?\s*)?([Xx*\d]*\d{2,4})/i);
  if (!amountMatch || !/\bcredit(?:ed)?\b/i.test(text) || !/(?:\bUPI\b|\bVPA\b|\bRRN\b)/i.test(text)) {
    return { ok: false, reason: "axis_not_recognized_upi_credit" };
  }
  return buildCreditEvent("AXIS", text, options, {
    amount: amountMatch[1], dateTime: dateMatch?.[1] || null,
    utr: normalizeReference(utrMatch?.[1]),
    payerName: payerMatch?.[1]?.trim().replace(/[.;,]+$/, "") || null,
    upiId: vpaMatch?.[1] || null,
    accountSuffix: accountMatch?.[1] || null,
  });
}
