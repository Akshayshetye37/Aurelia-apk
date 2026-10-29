import test from "node:test";
import assert from "node:assert/strict";
import { createPaymentEvent, matchBankEvent, createPendingQueue } from "../src/payments/payment-engine.mjs";
import { parseBobCreditSms } from "../src/payments/parsers/bob.mjs";
import { parseSbiCreditSms } from "../src/payments/parsers/sbi.mjs";

const gpay = (name, amount, timestamp, eventId = "gpay-1") => createPaymentEvent({
  eventId, source: "gpay_notification", eventType: "payment_notification",
  payerName: name, amount, timestamp, receivedAt: timestamp
});

test("normalizes INR amounts to integer paise", () => {
  assert.equal(createPaymentEvent({ source: "test", eventType: "credit", amount: "240.00" }).amountPaise, 24000);
});

test("BOB parser extracts amount, timestamp and UTR but does not invent payer", () => {
  const result = parseBobCreditSms("Dear BOB UPI User: Your account is credited with INR 240.00 on 2026-04-05 07:52:40 AM by UPI Ref No 47580109460", { eventId: "bob-1" });
  assert.equal(result.ok, true);
  assert.equal(result.event.amountPaise, 24000);
  assert.equal(result.event.utr, "47580109460");
  assert.equal(result.event.payerName, null);
  assert.equal(result.event.bank, "BOB");
});

test("SBI parser extracts amount, remitter and reference using the same event schema", () => {
  const result = parseSbiCreditSms("Dear SBI User, your A/c X3522-credited by Rs.40 on 24Jun25 transfer from VAJE CHINMAY SURESH Ref No 106988076220 -SBI", { eventId: "sbi-1" });
  assert.equal(result.ok, true);
  assert.equal(result.event.amountPaise, 4000);
  assert.equal(result.event.payerName, "VAJE CHINMAY SURESH");
  assert.equal(result.event.utr, "106988076220");
  assert.equal(result.event.bank, "SBI");
});

test("SBI remitter and amount produce a strong match inside the time window", () => {
  const candidate = gpay("Vaje Chinmay Suresh", "40", "2025-06-24T10:00:00Z");
  const bank = createPaymentEvent({
    eventId: "sbi-2", source: "bank_sms", eventType: "credit",
    payerName: "VAJE CHINMAY SURESH", amount: "40",
    utr: "106988076220", timestamp: "2025-06-24T10:02:00Z"
  });
  const result = matchBankEvent(bank, [candidate]);
  assert.equal(result.decision, "matched");
});

test("amount-only BOB SMS remains review-required even with one candidate", () => {
  const candidate = gpay("Rahul Patil", "240", "2026-04-05T07:52:00Z");
  const parsed = parseBobCreditSms("Dear BOB UPI User: Your account is credited with INR 240.00 on 2026-04-05 07:52:40 AM by UPI Ref No 47580109460", { eventId: "bob-2" });
  const result = matchBankEvent(parsed.event, [candidate]);
  assert.equal(result.decision, "review");
  assert.equal(result.reason, "insufficient_identity_evidence");
});

test("queue rejects repeated UTR and event IDs", () => {
  const queue = createPendingQueue();
  const event = createPaymentEvent({ eventId: "bank-1", source: "bank_sms", eventType: "credit", amount: "40", utr: "123456" });
  assert.equal(queue.add(event).added, true);
  assert.equal(queue.add(event).reason, "duplicate_event");
  const duplicate = createPaymentEvent({ eventId: "bank-2", source: "bank_sms", eventType: "credit", amount: "40", utr: "123456" });
  assert.equal(queue.add(duplicate).reason, "duplicate_utr");
});

test("mismatched amounts never match", () => {
  const candidate = gpay("Rahul Patil", "240", "2026-04-05T07:52:00Z");
  const bank = createPaymentEvent({ eventId: "bob-3", source: "bank_sms", eventType: "credit", amount: "250", timestamp: "2026-04-05T07:52:40Z" });
  assert.equal(matchBankEvent(bank, [candidate]).decision, "pending");
});
