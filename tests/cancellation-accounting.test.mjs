import test from "node:test";
import assert from "node:assert/strict";
import { cancellationPaidAmount, buildCancellationJournal } from "../src/payments/cancellation-accounting.mjs";

test("returns the paid amount when all persisted representations agree", () => {
  const booking = {
    p: 25,
    original_amount_paid: 25,
    pays: [{ a: 25, amountPaise: 2500, m: "UPI", r: "UTR-1" }],
    payments: [{ amount: 25, amountPaise: 2500, method: "UPI", reference: "UTR-1" }],
    paymentSnapshot: [{ a: 25, amountPaise: 2500, m: "UPI", r: "UTR-1" }]
  };
  assert.equal(cancellationPaidAmount(booking), 25);
});

test("returns null instead of choosing the largest conflicting paid representation", () => {
  assert.equal(cancellationPaidAmount({
    p: 200,
    pays: [{ a: 100 }],
    payments: [{ amount: 100 }],
    paymentSnapshot: [{ amount: 100 }]
  }), null);
});

test("returns null when canonical rows and compatibility history differ", () => {
  assert.equal(cancellationPaidAmount({
    p: 100,
    pays: [{ a: 100 }],
    payments: [{ amount: 90 }],
    paymentSnapshot: [{ amount: 100 }]
  }), null);
});

test("returns null for malformed or precision-invalid payment rows", () => {
  assert.equal(cancellationPaidAmount({
    p: 10,
    pays: [{ a: 10, amountPaise: 1001 }],
    payments: [{ amount: 10 }],
    paymentSnapshot: [{ amount: 10 }]
  }), null);
  assert.equal(cancellationPaidAmount({
    p: 10,
    pays: [{ a: "not-money" }],
    payments: [{ amount: 10 }]
  }), null);
});

test("zero-paid booking is safe only when all declared values are zero", () => {
  assert.equal(cancellationPaidAmount({ p: 0, pays: [], payments: [], paymentSnapshot: [] }), 0);
  assert.equal(cancellationPaidAmount({ p: 25, pays: [], payments: [] }), null);
});

test("rejects an unverified positive paid total when no payment rows exist", () => {
  assert.equal(cancellationPaidAmount({ p: 25, pays: [], payments: [] }), null);
  assert.equal(cancellationPaidAmount({ original_amount_paid: 25 }), null);
});


test("no-refund cancellation clears the guest advance into retained revenue", () => {
  const result = buildCancellationJournal({ action: "no_refund", paidPaise: 20000, refundPaise: 0 });
  assert.deepEqual(result.lines, [
    { account: "Guest Advances Liability", debitPaise: 20000, creditPaise: 0 },
    { account: "Cancellation Revenue", debitPaise: 0, creditPaise: 20000 }
  ]);
  assert.equal(result.committed, true);
});

test("pending refund creates a payable liability and does not recognize retention early", () => {
  const result = buildCancellationJournal({ action: "pending", paidPaise: 20000, refundPaise: 10000 });
  assert.deepEqual(result.lines, [
    { account: "Guest Advances Liability", debitPaise: 10000, creditPaise: 0 },
    { account: "Refunds Payable Liability", debitPaise: 0, creditPaise: 10000 }
  ]);
  assert.equal(result.retainedPaise, 10000);
  assert.equal(result.pendingRecorded, true);
  assert.equal(result.committed, false);
});

test("settling a pending partial refund clears payable and recognizes only retained value", () => {
  const result = buildCancellationJournal({
    action: "partial", paidPaise: 20000, refundPaise: 10000, pendingLiabilityPaise: 10000
  });
  assert.deepEqual(result.lines, [
    { account: "Refunds Payable Liability", debitPaise: 10000, creditPaise: 0 },
    { account: "Cash & Bank", debitPaise: 0, creditPaise: 10000 },
    { account: "Guest Advances Liability", debitPaise: 10000, creditPaise: 0 },
    { account: "Cancellation Revenue", debitPaise: 0, creditPaise: 10000 }
  ]);
  assert.equal(result.committed, true);
  assert.equal(result.pendingRecorded, false);
});

test("rejects duplicate pending liabilities, pending no-refund and partial instalments", () => {
  assert.throws(() => buildCancellationJournal({
    action: "pending", paidPaise: 20000, refundPaise: 10000, pendingLiabilityPaise: 10000
  }), error => error.code === "PENDING_REFUND_ALREADY_EXISTS");
  assert.throws(() => buildCancellationJournal({
    action: "no_refund", paidPaise: 20000, refundPaise: 0, pendingLiabilityPaise: 10000
  }), error => error.code === "PENDING_REFUND_MUST_BE_SETTLED");
  assert.throws(() => buildCancellationJournal({
    action: "partial", paidPaise: 20000, refundPaise: 5000, pendingLiabilityPaise: 10000
  }), error => error.code === "PENDING_REFUND_SETTLEMENT_MISMATCH");
});

test("requires full and partial refund amounts to match their declared semantics", () => {
  assert.throws(() => buildCancellationJournal({
    action: "full", paidPaise: 20000, refundPaise: 10000
  }), error => error.code === "FULL_REFUND_MISMATCH");
  assert.throws(() => buildCancellationJournal({
    action: "partial", paidPaise: 20000, refundPaise: 20000
  }), error => error.code === "PARTIAL_REFUND_MISMATCH");
  assert.throws(() => buildCancellationJournal({
    action: "partial", paidPaise: 20000, refundPaise: 0
  }), error => error.code === "REFUND_MUST_BE_POSITIVE");
});


test("rejects payment row amounts with more than two decimal places", () => {
  assert.equal(cancellationPaidAmount({
    p: 12.345, pays: [{ a: 12.345 }], payments: [{ amount: 12.345 }]
  }), null);
});


test("PMS cancellation workflow uses the strict paid resolver and integer-paise journal builder", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /import \{ cancellationPaidAmount as resolveCancellationPaidAmount, buildCancellationJournal \}/);
  assert.match(html, /function cancellationPaidAmount\(b\)\{return typeof window\.AureliaCancellationPaidAmount==='function'\?window\.AureliaCancellationPaidAmount\(b\):null\}/);
  assert.match(html, /if\(paid===null\)\{toast\('Refund blocked:/);
  assert.match(html, /Actual refund transaction reference \(required for paid refunds\)/);
  assert.match(html, /refund_reference:decision\.committed&&refundPaise>0\?refundReference:null/);
  assert.match(html, /cancellationJournal\(ref,decision\.lines/);
  assert.match(html, /Refund blocked: paid representations do not agree/);
});

test("cancelled booking snapshots prefer canonical pays rows over the compatibility history mirror", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /paymentSnapshot:Array\.isArray\(b\.pays\)\?b\.pays\.map/);
  assert.match(html, /if\(b\.cancellationAccountingCommitted\)\{/);
  assert.match(html, /pendingLiabilityPaise=priorEntries\.reduce/);
});
