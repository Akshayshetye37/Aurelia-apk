import { createPaymentEvent, parseAmountToPaise } from "../payment-engine.mjs";

/**
 * Parses the observed BOB credit SMS format:
 * "Dear BOB UPI User: Your account is credited with INR 240.00 on
 * 2026-04-05 07:52:40 AM by UPI Ref No 47580109460"
 *
 * This format does not identify the remitter. Do not infer a payer name.
 */
export function parseBobCreditSms(raw, options = {}) {
  const text = String(raw || "").trim();
  const amountMatch = text.match(/credited\s+with\s+(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i);
  const timeMatch = text.match(/on\s+(\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}:\d{2}\s*(?:AM|PM)?)/i);
  const utrMatch = text.match(/(?:UPI\s+Ref(?:erence)?\s+No\.?|Ref\s+No\.?)\s*([A-Z0-9]+)/i);
  const accountMatch = text.match(/(?:A\/c|account)\s+(?:no\.?\s*)?([Xx*\d]+\d{2,4})/i);

  if (!amountMatch) return { ok: false, reason: "bob_credit_amount_not_found" };
  const amountPaise = parseAmountToPaise(amountMatch[1]);
  let timestamp = null;
  if (timeMatch) {
    const normalized = timeMatch[1].replace(/\s+(AM|PM)$/i, " $1");
    const parsed = new Date(normalized);
    if (!Number.isNaN(parsed.getTime())) timestamp = parsed.toISOString();
  }

  const event = createPaymentEvent({
    eventId: options.eventId,
    evidenceId: options.evidenceId,
    source: "bank_sms",
    eventType: "credit",
    amountPaise,
    timestamp,
    timestampPrecision: timestamp ? "exact" : "date_or_unknown",
    utr: utrMatch?.[1] || null,
    payerName: null,
    bank: "BOB",
    accountSuffix: accountMatch?.[1] || null,
    rawEvidence: text,
    receivedAt: options.receivedAt,
  });
  return { ok: true, event };
}
