import { buildCreditEvent, normalizeReference } from "./common.mjs";

/** Observed Kotak received-UPI SMS form: Received Rs... from VPA ... UPI Ref:... */
export function parseKotakCreditSms(raw, options = {}) {
  const text = String(raw || "").trim();
  const amountMatch = text.match(/\bReceived\s+(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i);
  const dateMatch = text.match(/\bon\s+(\d{1,2}[-/]\d{1,2}[-/]\d{2,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)/i);
  const vpaMatch = text.match(/\bfrom\s+([A-Z0-9._-]+@[A-Z0-9.-]+)/i);
  const utrMatch = text.match(/UPI\s+Ref\s*[:#]?\s*([A-Z0-9]{6,})/i);
  const accountMatch = text.match(/\bAC\s+([Xx*\d]*\d{2,4})/i);
  if (!amountMatch || !vpaMatch || !/\bUPI\b/i.test(text)) return { ok: false, reason: "kotak_not_recognized_upi_credit" };
  return buildCreditEvent("KOTAK", text, options, {
    amount: amountMatch[1], dateTime: dateMatch?.[1] || null,
    utr: normalizeReference(utrMatch?.[1]), upiId: vpaMatch[1],
    accountSuffix: accountMatch?.[1] || null, payerName: null,
  });
}
