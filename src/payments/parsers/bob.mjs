import { createPaymentEvent, parseAmountToPaise } from "../payment-engine.mjs";
import { parseIndianDateTime } from "./common.mjs";

/** Observed BOB credit format; this example does not identify the remitter. */
export function parseBobCreditSms(raw, options = {}) {
  const text = String(raw || "").trim();
  const amountMatch = text.match(/credited\s+with\s+(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i);
  const timeMatch = text.match(/on\s+(\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}:\d{2}\s*(?:AM|PM)?)/i);
  const utrMatch = text.match(/(?:UPI\s+Ref(?:erence)?\s+No\.?|Ref\s+No\.?)\s*([A-Z0-9]+)/i);
  const accountMatch = text.match(/(?:A\/c|account)\s+(?:no\.?\s*)?([Xx*\d]+\d{2,4})/i);
  if (!amountMatch) return { ok: false, reason: "bob_credit_amount_not_found" };
  let amountPaise;
  try { amountPaise = parseAmountToPaise(amountMatch[1]); }
  catch { return { ok: false, reason: "bob_credit_amount_invalid" }; }
  const parsedDate = parseIndianDateTime(timeMatch?.[1] || null);
  const event = createPaymentEvent({
    eventId: options.eventId, evidenceId: options.evidenceId, source: "bank_sms",
    eventType: "credit", amountPaise, timestamp: parsedDate.timestamp,
    timestampPrecision: parsedDate.precision, utr: utrMatch?.[1] || null,
    payerName: null, bank: "BOB", accountSuffix: accountMatch?.[1] || null,
    rawEvidence: text, receivedAt: options.receivedAt,
  });
  return { ok: true, event };
}
