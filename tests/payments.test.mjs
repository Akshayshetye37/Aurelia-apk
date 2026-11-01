import test from "node:test";
import assert from "node:assert/strict";
import { createPaymentEvent, matchBankEvent, createPendingQueue } from "../src/payments/payment-engine.mjs";
import { parseBobCreditSms } from "../src/payments/parsers/bob.mjs";
import { parseSbiCreditSms } from "../src/payments/parsers/sbi.mjs";

import { parseIciciCreditSms } from "../src/payments/parsers/icici.mjs";
import { parseHdfcCreditSms } from "../src/payments/parsers/hdfc.mjs";
import { parseAxisCreditSms } from "../src/payments/parsers/axis.mjs";
import { parseIndianDateTime } from "../src/payments/parsers/common.mjs";

import { parseKotakCreditSms } from "../src/payments/parsers/kotak.mjs";
import { parseUcoCreditSms } from "../src/payments/parsers/uco.mjs";
test("Kotak received-UPI variant extracts VPA and reference", () => {
  const r = parseKotakCreditSms("Received Rs.50.00 in your Kotak Bank AC X8136 from abcd4321@oksbi on 03-02-24.UPI Ref:400653974000.", { eventId: "kotak-1" });
  assert.equal(r.ok, true); assert.equal(r.event.amountPaise, 5000);
  assert.equal(r.event.upiId, "abcd4321@oksbi"); assert.equal(r.event.utr, "400653974000");
});
test("UCO credit variant with UPI marker does not invent payer or UTR", () => {
  const r = parseUcoCreditSms("A/c XX8360 Credited with Rs.6.00 on 07-02-2024 by UCO-UPI.", { eventId: "uco-1" });
  assert.equal(r.ok, true); assert.equal(r.event.amountPaise, 600);
  assert.equal(r.event.payerName, null); assert.equal(r.event.utr, null);
});


test("ICICI observed incoming UPI credit format extracts payer and reference", () => {
  const r = parseIciciCreditSms("Dear Customer, Acct XX922 is credited with Rs 500.00 on 07-Jun-25 from PRASHANT SHARMA. UPI:515853359128-ICICI Bank.", { eventId: "icici-1" });
  assert.equal(r.ok, true); assert.equal(r.event.amountPaise, 50000);
  assert.equal(r.event.payerName, "PRASHANT SHARMA"); assert.equal(r.event.utr, "515853359128");
});
test("HDFC observed UPI credit format extracts VPA, reference and account suffix", () => {
  const r = parseHdfcCreditSms("HDFC Bank: Rs. 1.00 credited to a/c XXXXXX2002 on 23-01-24 by a/c linked to VPA 9777777711@fam (UPI Ref No 408888887329).", { eventId: "hdfc-1" });
  assert.equal(r.ok, true); assert.equal(r.event.amountPaise, 100);
  assert.equal(r.event.upiId, "9777777711@fam"); assert.equal(r.event.utr, "408888887329");
  assert.equal(r.event.accountSuffix, "2002");
});
test("Axis parser accepts explicit UPI credit and rejects generic credit without UPI evidence", () => {
  const r = parseAxisCreditSms("Rs.500.00 credited to A/c XX1234 on 27-04-2026 17:13 by VPA guest@okaxis UPI Ref 528871234567", { eventId: "axis-1" });
  assert.equal(r.ok, true); assert.equal(r.event.amountPaise, 50000);
  assert.equal(r.event.utr, "528871234567"); assert.equal(r.event.upiId, "guest@okaxis");
  assert.equal(parseAxisCreditSms("Rs.500.00 credited to A/c XX1234 on 27-04-2026 17:13. Avl Bal Rs.12,450").ok, false);
});
test("shared date parser interprets local bank clock time as IST", () => {
  assert.deepEqual(parseIndianDateTime("2026-04-05 07:52:40 AM"), { timestamp: "2026-04-05T02:22:40.000Z", precision: "exact" });
  assert.deepEqual(parseIndianDateTime("24Jun25"), { timestamp: "2025-06-23T18:30:00.000Z", precision: "date_only" });
});
test("temporary HDFC credit under review is rejected for manual review", () => {
  const r = parseHdfcCreditSms("INR 70,900.00 deposited in HDFC Bank Account No. XXX8261 on 14-Sep-23 for TEMP CR UPI CRM 31721058 under review. Avl bal INR 87686.12");
  assert.equal(r.ok, false); assert.equal(r.reason, "hdfc_credit_requires_manual_review");
});


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
  const result = parseSbiCreditSms("Dear SBI User, your A/c X3522-credited by Rs.40 on 24Jun25 transfer from VAJE CHINMAY SURESH Ref No 106988076220 -SBI", { eventId: "sbi-1", receivedAt: "2025-06-24T10:02:00Z" });
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
    utr: "106988076220", timestamp: "2025-06-24T10:02:00Z", receivedAt: "2025-06-24T10:02:00Z"
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

test("queue rejects repeated UTR and event IDs within the same bank-account scope", () => {
  const queue = createPendingQueue();
  const event = createPaymentEvent({ eventId: "bank-1", source: "bank_sms", eventType: "credit", amount: "40", utr: "123456", bank: "SBI", accountSuffix: "3522" });
  assert.equal(queue.add(event).added, true);
  assert.equal(queue.add(event).reason, "duplicate_event");
  const duplicate = createPaymentEvent({ eventId: "bank-2", source: "bank_sms", eventType: "credit", amount: "40", utr: "123456", bank: "SBI", accountSuffix: "3522" });
  assert.equal(queue.add(duplicate).reason, "duplicate_utr");
  const otherBank = createPaymentEvent({ eventId: "bank-3", source: "bank_sms", eventType: "credit", amount: "40", utr: "123456", bank: "BOB", accountSuffix: "3522" });
  assert.equal(queue.add(otherBank).added, true);
  const otherAccount = createPaymentEvent({ eventId: "bank-4", source: "bank_sms", eventType: "credit", amount: "40", utr: "123456", bank: "SBI", accountSuffix: "7777" });
  assert.equal(queue.add(otherAccount).added, true);
});

test("mismatched amounts never match", () => {
  const candidate = gpay("Rahul Patil", "240", "2026-04-05T07:52:00Z");
  const bank = createPaymentEvent({ eventId: "bob-3", source: "bank_sms", eventType: "credit", amount: "250", timestamp: "2026-04-05T07:52:40Z" });
  assert.equal(matchBankEvent(bank, [candidate]).decision, "pending");
});

test("bank credit cannot be passed as a payment candidate to itself", () => {
  const bankEvent = createPaymentEvent({
    eventId:"statement-credit", source:"statement_import", eventType:"credit",
    bank:"SBI", amount:"40", currency:"INR", utr:"123456789012"
  });
  assert.equal(matchBankEvent(bankEvent, [bankEvent]).decision, "pending");
});

test("payment event matching rejects a candidate in a different currency", () => {
  const candidate = createPaymentEvent({
    eventId:"usd-candidate", source:"gpay_notification",
    eventType:"payment_notification", currency:"USD",
    payerName:"A Guest", amount:"40", timestamp:"2026-01-01T10:00:00Z"
  });
  const bankEvent = createPaymentEvent({
    eventId:"inr-bank", source:"bank_sms", eventType:"credit",
    currency:"INR", bank:"SBI", amount:"40",
    timestamp:"2026-01-01T10:00:00Z"
  });
  assert.equal(matchBankEvent(bankEvent, [candidate]).decision, "pending");
});

test("payment event rejects invalid receivedAt and oversized evidence text", () => {
  assert.throws(() => createPaymentEvent({ eventId:"bad-time", amount:"10", receivedAt:"not-a-date" }), /receivedAt/);
  assert.throws(() => createPaymentEvent({ eventId:"large", amount:"10", rawEvidence:"x".repeat(8193) }), /8192/);
});

test("payment event rejects malformed event timestamps and precision labels", () => {
  assert.throws(() => createPaymentEvent({ eventId:"bad-event-time", amount:"10", timestamp:"not-a-date" }), /event timestamp/);
  assert.throws(() => createPaymentEvent({ eventId:"bad-precision", amount:"10", timestampPrecision:"verified" }), /timestampPrecision/);
});
