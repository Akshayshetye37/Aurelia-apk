import { createPaymentEvent, parseAmountToPaise } from "../payment-engine.mjs";

/**
 * Parses the observed SBI credit SMS format:
 * "Dear SBI User, your A/c X3522-credited by Rs.40 on 24Jun25
 * transfer from VAJE CHINMAY SURESH Ref No 106988076220 -SBI"
 */
export function parseSbiCreditSms(raw, options = {}) {
  const text = String(raw || "").trim();
  const amountMatch = text.match(/credited\s+by\s+(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i);
  const dateMatch = text.match(/\bon\s+(\d{1,2}[A-Za-z]{3}\d{2,4})\b/i);
  const payerMatch = text.match(/transfer\s+from\s+(.+?)\s+Ref\s+No\.?\s*([A-Z0-9]+)/i);
  const utrMatch = text.match(/Ref\s+No\.?\s*([A-Z0-9]+)/i);
  const accountMatch = text.match(/A\/c\s+([Xx*\d]+\d{2,4})/i);

  if (!amountMatch) return { ok: false, reason: "sbi_credit_amount_not_found" };
  const amountPaise = parseAmountToPaise(amountMatch[1]);
  let timestamp = null;
  if (dateMatch) {
    const match = dateMatch[1].match(/^(\d{1,2})([A-Za-z]{3})(\d{2,4})$/);
    if (match) {
      const year = Number(match[3].length === 2 ? `20${match[3]}` : match[3]);
      const month = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"].indexOf(match[2].toLowerCase());
      if (month >= 0) {
        const date = new Date(Date.UTC(year, month, Number(match[1])));
        if (!Number.isNaN(date.getTime())) timestamp = date.toISOString();
      }
    }
  }
  const payerName = payerMatch?.[1]?.trim() || null;
  const event = createPaymentEvent({
    eventId: options.eventId,
    evidenceId: options.evidenceId,
    source: "bank_sms",
    eventType: "credit",
    amountPaise,
    timestamp,
    timestampPrecision: timestamp ? "date_only" : "unknown",
    utr: utrMatch?.[1] || null,
    payerName,
    bank: "SBI",
    accountSuffix: accountMatch?.[1] || null,
    rawEvidence: text,
    receivedAt: options.receivedAt,
  });
  return { ok: true, event };
}
