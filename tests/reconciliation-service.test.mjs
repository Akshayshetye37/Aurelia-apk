import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { createEvidenceStore } from "../src/payments/evidence-store.mjs";
import { createReconciliationService } from "../src/payments/reconciliation-service.mjs";
import { createPaymentEvent, matchBankEvent } from "../src/payments/payment-engine.mjs";

const gpay = (eventId = "gpay-1") => createPaymentEvent({
  eventId, evidenceId: eventId, source: "gpay_notification", eventType: "payment_notification",
  payerName: "Vaje Chinmay Suresh", amount: "40",
  timestamp: "2025-06-24T10:00:00Z", receivedAt: "2025-06-24T10:00:00Z"
});
const bank = (eventId = "sbi-1") => createPaymentEvent({
  eventId, evidenceId: eventId, source: "bank_sms", eventType: "credit",
  bank: "SBI", accountSuffix: "3522", payerName: "VAJE CHINMAY SURESH",
  amount: "40", utr: "106988076220", timestamp: "2025-06-24T10:02:00Z",
  receivedAt: "2025-06-24T10:02:00Z"
});

test("reconciliation works when GPay evidence arrives before bank SMS", async () => {
  const store = createEvidenceStore({ indexedDB, dbName: "order-gpay-first" });
  const service = createReconciliationService({ store });
  await service.ingest(gpay());
  const result = await service.ingest(bank());
  assert.equal(result.reconciliation.results[0].decision, "matched");
  assert.equal(result.reconciliation.settlementEnabled, false);
  await store.close();
});

test("reconciliation works when bank SMS arrives before GPay evidence", async () => {
  const store = createEvidenceStore({ indexedDB, dbName: "order-bank-first" });
  const service = createReconciliationService({ store });
  const first = await service.ingest(bank());
  assert.equal(first.reconciliation.results[0].decision, "pending");
  const second = await service.ingest(gpay());
  assert.equal(second.reconciliation.results[0].decision, "matched");
  await store.close();
});

test("unknown SMS stays in review without fabricated amount or identity", async () => {
  const store = createEvidenceStore({ indexedDB, dbName: "unknown-format" });
  const service = createReconciliationService({ store });
  const result = await service.ingest({
    eventId: "unknown-1", evidenceId: "unknown-1", source: "bank_sms",
    eventType: "unknown", parseStatus: "unparsed", amountPaise: null,
    payerName: null, utr: null, rawEvidence: "REDACTED UNKNOWN SMS"
  });
  assert.equal(result.reconciliation.unparsedEvidence[0].reason, "unparsed_evidence");
  assert.equal(result.reconciliation.settlementEnabled, false);
  await store.close();
});

test("conflicting UTRs force review even when amount and payer match", () => {
  const candidate = createPaymentEvent({
    eventId: "candidate", source: "guest_utr", eventType: "payment_candidate",
    payerName: "A Guest", amount: "100", utr: "111111111111",
    timestamp: "2026-01-01T10:00:00Z"
  });
  const bankEvent = createPaymentEvent({
    eventId: "bank", source: "bank_sms", eventType: "credit", bank: "SBI",
    payerName: "A Guest", amount: "100", utr: "222222222222",
    timestamp: "2026-01-01T10:00:30Z"
  });
  const result = matchBankEvent(bankEvent, [candidate]);
  assert.equal(result.decision, "review");
  assert.equal(result.reason, "conflicting_transaction_identity");
});

test("multiple strong candidate matches remain in review", () => {
  const first = gpay("gpay-a");
  const second = gpay("gpay-b");
  const result = matchBankEvent(bank(), [first, second]);
  assert.equal(result.decision, "review");
  assert.equal(result.reason, "multiple_strong_candidates");
});

test("bank statement credits are not reused as their own candidate evidence", async () => {
  const store = createEvidenceStore({ indexedDB, dbName:"statement-self-match" });
  const service = createReconciliationService({ store });
  const result = await service.ingest({
    eventId:"statement-credit", evidenceId:"statement-credit",
    source:"statement_import", eventType:"credit", bank:"SBI",
    amount:"40", currency:"INR", utr:"123456789012",
    timestamp:"2026-01-01T10:00:00Z"
  });
  assert.equal(result.reconciliation.results.length, 1);
  assert.equal(result.reconciliation.results[0].decision, "pending");
  await store.close();
});

test("unparsed candidate evidence is retained but excluded from matching", async () => {
  const store = createEvidenceStore({ indexedDB, dbName:"unparsed-candidate" });
  const service = createReconciliationService({ store });
  await service.ingest(gpay("valid-candidate"));
  await service.ingest({
    eventId:"unparsed-candidate", evidenceId:"unparsed-candidate",
    source:"gpay_notification", eventType:"payment_notification",
    parseStatus:"unparsed", amountPaise:null, payerName:null, utr:null,
    rawEvidence:"UNKNOWN PAYMENT NOTIFICATION"
  });
  const result = await service.ingest(bank("bank-after-unparsed"));
  assert.equal(result.reconciliation.results[0].decision, "matched");
  assert.equal(result.reconciliation.unparsedEvidence.length, 1);
  await store.close();
});

test("unsupported currency evidence is retained for review and never matched", async () => {
  const store = createEvidenceStore({ indexedDB, dbName:"unsupported-currency" });
  const service = createReconciliationService({ store });
  const result = await service.ingest({
    eventId:"usd-1", evidenceId:"usd-1", source:"gpay_notification",
    eventType:"payment_notification", currency:"USD", amount:"40",
    payerName:"A Guest", timestamp:"2026-01-01T10:00:00Z",
    rawEvidence:"REDACTED USD NOTICE"
  });
  assert.equal(result.reconciliation.unparsedEvidence[0].reason, "unsupported_currency");
  assert.equal(result.reconciliation.results.length, 0);
  await store.close();
});

test("caller-supplied normalized payer fields are ignored", async () => {
  const store = createEvidenceStore({ indexedDB, dbName:"normalized-fields" });
  const service = createReconciliationService({ store });
  await service.ingest({
    eventId:"forged-1", evidenceId:"forged-1", source:"gpay_notification",
    eventType:"payment_notification", payerName:"Original Guest",
    payerNameNormalized:"ATTACKER CHOSEN NAME", upiId:"guest@upi",
    upiIdNormalized:"attacker@upi", amount:"40",
    timestamp:"2026-01-01T10:00:00Z"
  });
  const stored = await store.getEvidence("forged-1");
  assert.equal(stored.payerNameNormalized, "ORIGINAL GUEST");
  assert.equal(stored.upiIdNormalized, "guest@upi");
  await store.close();
});

test("unsupported parse status is rejected instead of treated as parsed", async () => {
  const store = createEvidenceStore({ indexedDB, dbName:"invalid-parse-status" });
  const service = createReconciliationService({ store });
  await assert.rejects(service.ingest({
    eventId:"bad-status", evidenceId:"bad-status", source:"gpay_notification",
    parseStatus:"verified", amount:"40"
  }), /parseStatus/);
  await store.close();
});
