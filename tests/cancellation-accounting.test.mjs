import test from "node:test";
import assert from "node:assert/strict";
import { cancellationPaidAmount } from "../src/payments/cancellation-accounting.mjs";

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
