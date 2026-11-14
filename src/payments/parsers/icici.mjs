import { buildCreditEvent, normalizeReference } from "./common.mjs";

/**
 * Supports observed ICICI incoming-credit variants, including:
 * "Dear Customer, Acct XX922 is credited with Rs 500.00 on 07-Jun-25
 * from PRASHANT SHARMA. UPI:515853359128-ICICI Bank."
 * Unknown or non-credit messages fail closed.
 */
export function parseIciciCreditSms(raw, options = {}) {
  const text = String(raw || "").trim();
  const amountMatch =
    text.match(/(?:Acct|Account)\s+X{0,}[\dX*]+\s+(?:is\s+)?credited\s*:?\s*(?:with\s*)?(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i) ||
    text.match(/(?:Acct|Account)\s+X{0,}[\dX*]+\s+is\s+credited\s+with\s+(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i);
  const altAmount = text.match(/credited\s*:?\s*(?:with\s*)?(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i);
  const amount = amountMatch?.[1] || altAmount?.[1];
  const dateMatch = text.match(/\bon\s+(\d{1,2}[-/][A-Za-z0-9]{2,3}[-/]\d{2,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)/i) ||
    text.match(/\bon\s+(\d{1,2}[-/]\d{1,2}[-/]\d{2,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)/i);
  const utrMatch = text.match(/(?:UPI\s*:\s*|UPI\s+(?:Ref(?:erence)?\s*(?:No\.?)?\s*|RRN\s*[:#]?\s*|Ref\s*[:#]?\s*))([A-Z0-9]{6,})/i);
  const vpaMatch = text.match(/(?:VPA|UPI\s*ID)\s*[:=]?\s*([A-Z0-9._-]+@[A-Z0-9.-]+)/i);
  const payerMatch = text.match(/\bfrom\s+(.+?)(?=\s*[.;,]?\s*(?:UPI\s*:|UPI\s+Ref|RRN|Avl\.?\s*Bal|Available Balance|$))/i);
  const accountMatch = text.match(/(?:Acct|Account)\s+(?:No\.?\s*)?([Xx*\d]*\d{2,4})/i);
  if (!amount || !/\bcredit(?:ed)?\b/i.test(text) || !/(?:\bUPI\b|\bVPA\b|\bRRN\b)/i.test(text)) {
    return { ok: false, reason: "icici_not_recognized_upi_credit" };
  }
  return buildCreditEvent("ICICI", text, options, {
    amount, dateTime: dateMatch?.[1] || null,
    utr: normalizeReference(utrMatch?.[1]),
    payerName: payerMatch?.[1]?.trim().replace(/[.;,]+$/, "") || null,
    upiId: vpaMatch?.[1] || null,
    accountSuffix: accountMatch?.[1] || null,
  });
}
