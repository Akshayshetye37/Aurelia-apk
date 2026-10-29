import { buildCreditEvent, normalizeReference } from "./common.mjs";

/**
 * Supports observed HDFC incoming UPI-credit variants, including:
 * "HDFC Bank: Rs. 1.00 credited to a/c XXXXXX2002 on 23-01-24
 * by a/c linked to VPA 9777777711@fam (UPI Ref No 408888887329)."
 *
 * This parser does not treat temporary/provisional credits under dispute as
 * settled UPI payments; those require manual review.
 */
export function parseHdfcCreditSms(raw, options = {}) {
  const text = String(raw || "").trim();
  if (/\b(?:TEMP(?:ORARY)?\s+CR|PROVISIONAL\s+CREDIT|UNDER\s+REVIEW|REVERSAL|REVERSED)\b/i.test(text)) {
    return { ok: false, reason: "hdfc_credit_requires_manual_review" };
  }
  const amountMatch = text.match(/(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)\s+credited\b/i) ||
    text.match(/credited\s+(?:with\s+)?(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i);
  const dateMatch = text.match(/\bon\s+(\d{1,2}[-/]\d{1,2}[-/]\d{2,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)/i) ||
    text.match(/\bon\s+(\d{1,2}[- ][A-Za-z]{3}[- ]\d{2,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)/i);
  const utrMatch = text.match(/(?:UPI\s+Ref(?:erence)?\s+No\.?|UPI\s*[:#]|RRN\s*[:#]?)\s*([A-Z0-9]{6,})/i);
  const vpaMatch = text.match(/(?:VPA|a\/c\s+linked\s+to\s+VPA)\s*[:=]?\s*([A-Z0-9._-]+@[A-Z0-9.-]+)/i);
  const payerMatch = text.match(/\bfrom\s+(.+?)(?=\s*(?:\(|UPI|RRN|Avl\.?\s*bal|Available Balance|$))/i);
  const accountMatch = text.match(/(?:A\/c|account)\s+(?:No\.?\s*)?([Xx*\d]*\d{2,4})/i);
  if (!amountMatch || !/\bcredit(?:ed)?\b/i.test(text) || !/(?:\bUPI\b|\bVPA\b|\bRRN\b)/i.test(text)) {
    return { ok: false, reason: "hdfc_not_recognized_upi_credit" };
  }
  return buildCreditEvent("HDFC", text, options, {
    amount: amountMatch[1], dateTime: dateMatch?.[1] || null,
    utr: normalizeReference(utrMatch?.[1]),
    payerName: payerMatch?.[1]?.trim().replace(/[.;,]+$/, "") || null,
    upiId: vpaMatch?.[1] || null,
    accountSuffix: accountMatch?.[1] || null,
  });
}
