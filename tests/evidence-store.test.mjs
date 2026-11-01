import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { createEvidenceStore } from "../src/payments/evidence-store.mjs";
import { AUTO_FOLIO_SETTLEMENT_ENABLED, assertAutoFolioSettlementEnabled } from "../src/payments/settlement-gate.mjs";

const base = (overrides = {}) => ({
  evidenceId: "evidence-1",
  eventId: "event-1",
  source: "bank_sms",
  parseStatus: "parsed",
  eventType: "credit",
  amountPaise: 24000,
  currency: "INR",
  bank: "BOB",
  accountScope: "property-account-1",
  utr: "47580109460",
  receivedAt: "2026-04-05T02:22:40.000Z",
  rawEvidence: "REDACTED TEST SMS",
  ...overrides
});

test("evidence survives closing and reopening the store", async () => {
  const dbName = "persist-" + Math.random().toString(36).slice(2);
  const first = createEvidenceStore({ indexedDB, dbName });
  assert.equal((await first.addEvidence(base())).added, true);
  await first.close();

  const reopened = createEvidenceStore({ indexedDB, dbName });
  const restored = await reopened.getEvidence("evidence-1");
  assert.equal(restored.eventId, "event-1");
  assert.equal(restored.amountPaise, 24000);
  assert.equal(restored.rawEvidence, "REDACTED TEST SMS");
  await reopened.close();
});

test("durable deduplication rejects repeated event IDs", async () => {
  const store = createEvidenceStore({ indexedDB, dbName: "event-dedup" });
  assert.equal((await store.addEvidence(base())).added, true);
  const duplicate = await store.addEvidence(base({ evidenceId: "evidence-2" }));
  assert.equal(duplicate.added, false);
  assert.equal(duplicate.reason, "duplicate_event");
  await store.close();
});

test("durable UTR deduplication is scoped to bank account", async () => {
  const store = createEvidenceStore({ indexedDB, dbName: "utr-dedup" });
  assert.equal((await store.addEvidence(base())).added, true);
  const sameScope = await store.addEvidence(base({ evidenceId: "evidence-2", eventId: "event-2" }));
  assert.equal(sameScope.added, false);
  assert.equal(sameScope.reason, "duplicate_utr");

  const otherScope = await store.addEvidence(base({
    evidenceId: "evidence-3", eventId: "event-3", accountScope: "another-account"
  }));
  assert.equal(otherScope.added, true);
  await store.close();
});

test("unparsed evidence with unknown amount is retained without invented fields", async () => {
  const store = createEvidenceStore({ indexedDB, dbName: "unparsed" });
  const result = await store.addEvidence(base({
    evidenceId: "evidence-unparsed", eventId: "event-unparsed",
    parseStatus: "unparsed", amountPaise: null, payerName: null, utr: null,
    rawEvidence: "UNKNOWN FORMAT REDACTED"
  }));
  assert.equal(result.added, true);
  assert.equal(result.record.amountPaise, null);
  assert.equal(result.record.payerName, null);
  assert.equal(result.record.utr, null);
  await store.close();
});

test("review decisions are persisted with evidence linkage", async () => {
  const store = createEvidenceStore({ indexedDB, dbName: "decisions" });
  await store.addEvidence(base());
  const decision = await store.recordDecision({
    decisionId: "decision-1", evidenceId: "evidence-1", decision: "needs_review",
    reason: "insufficient_identity_evidence", reviewerId: "staff-test"
  });
  assert.equal(decision.decision, "needs_review");
  assert.equal((await store.listDecisions("evidence-1")).length, 1);
  await store.close();
});

test("automatic folio settlement is explicitly disabled", () => {
  assert.equal(AUTO_FOLIO_SETTLEMENT_ENABLED, false);
  assert.throws(assertAutoFolioSettlementEnabled, /settlement is disabled/i);
});

test("evidence input rejects oversized raw text and invalid currency", async () => {
  const store = createEvidenceStore({ indexedDB, dbName:"bounded-evidence" });
  await assert.rejects(store.addEvidence(base({ rawEvidence:"x".repeat(8193) })), /8192/);
  await assert.rejects(store.addEvidence(base({ currency:"US" })), /currency/);
  await store.close();
});

test("staff decisions require an existing evidence record and review-only outcome", async () => {
  const store = createEvidenceStore({ indexedDB, dbName:"decision-integrity" });
  await assert.rejects(store.recordDecision({
    decisionId:"orphan", evidenceId:"missing", decision:"needs_review",
    reason:"missing evidence", reviewerId:"staff-1"
  }), /missing evidence/);
  await store.addEvidence(base());
  await assert.rejects(store.recordDecision({
    decisionId:"paid", evidenceId:"evidence-1", decision:"paid",
    reason:"not allowed", reviewerId:"staff-1"
  }), /review-only/);
  await store.close();
});
