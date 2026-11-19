import { createPaymentEvent, parseAmountToPaise } from "../payment-engine.mjs";
import { parseIndianDateTime } from "./common.mjs";

/** Observed SBI credit format with compact date, remitter and reference. */
export function parseSbiCreditSms(raw, options = {}) {
  const text = String(raw || "").trim();
  const amountMatch = text.match(/credited\s+by\s+(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i);
  const dateMatch = text.match(/\bon\s+(\d{1,2}[A-Za-z]{3}\d{2,4})\b/i);
  const payerMatch = text.match(/transfer\s+from\s+(.+?)\s+Ref\s+No\.?\s*([A-Z0-9]+)/i);
  const utrMatch = text.match(/(?:Ref\s+No\.?|Refno\s*)\s*([A-Z0-9]+)/i);
  const accountMatch = text.match(/A\/c\s*([Xx*\d]*\d{2,4})/i);
  if (!amountMatch) return { ok: false, reason: "sbi_credit_amount_not_found" };
  let amountPaise;
  try { amountPaise = parseAmountToPaise(amountMatch[1]); }
  catch { return { ok: false, reason: "sbi_credit_amount_invalid" }; }
  const parsedDate = parseIndianDateTime(dateMatch?.[1] || null);
  const event = createPaymentEvent({
    eventId: options.eventId, evidenceId: options.evidenceId, source: "bank_sms",
    eventType: "credit", amountPaise, timestamp: parsedDate.timestamp,
    timestampPrecision: parsedDate.precision, utr: utrMatch?.[1] || null,
    payerName: payerMatch?.[1]?.trim() || null, bank: "SBI",
    accountSuffix: accountMatch?.[1] || null, rawEvidence: text,
    receivedAt: options.receivedAt,
  });
  return { ok: true, event };
}
