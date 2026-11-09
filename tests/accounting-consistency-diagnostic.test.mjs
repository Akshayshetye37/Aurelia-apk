import test from "node:test";
import assert from "node:assert/strict";
import { diagnoseAccountingConsistency } from "../src/payments/accounting-consistency-diagnostic.mjs";

test("reports a clean booking as consistent", () => {
  const result = diagnoseAccountingConsistency({ b: [{ id: 1, p: 12.34, pays: [{ a: 12.34 }] }] });
  assert.equal(result.affectedBookingCount, 0);
  assert.equal(result.malformedBookingCount, 0);
});

test("detects legacy paid total without canonical rows", () => {
  const result = diagnoseAccountingConsistency({ b: [{ id: 2, p: 25, pays: [], payments: [{ amount: 25 }] }] });
  assert.equal(result.findings[0].deltaPaise, 2500);
  assert.equal(result.findings[0].hasLegacyPayments, true);
});

test("detects rows-only and signed mismatches in paise", () => {
  const result = diagnoseAccountingConsistency({ b: [
    { id: 3, p: 0, pays: [{ amountPaise: 999 }] },
    { id: 4, p: 10, pays: [{ a: 12.5 }] }
  ] });
  assert.deepEqual(result.findings.map(x => x.deltaPaise), [-999, -250]);
  assert.equal(result.totalAbsoluteDiscrepancyPaise, 1249);
});

test("reports malformed payment rows without guessing a balance", () => {
  const result = diagnoseAccountingConsistency({ b: [
    { id: 5, p: 10, pays: [{ a: "not-money" }] },
    { id: 6, p: "bad", pays: [] },
    { id: 7, p: 1, pays: "invalid" }
  ] });
  assert.equal(result.affectedBookingCount, 0);
  assert.equal(result.malformedBookingCount, 3);
});

test("includes cancelled and imported/legacy-shaped bookings", () => {
  const result = diagnoseAccountingConsistency({
    b: [{ id: 8, p: 1.01, pays: [{ amountPaise: 100 }] }],
    cancelled: [{ id: "old-9", p: 0, pays: [{ a: 2 }] }]
  });
  assert.equal(result.scannedBookingCount, 2);
  assert.deepEqual(result.findings.map(x => x.collection), ["active", "cancelled"]);
  assert.equal(result.findings[1].deltaPaise, -200);
});

test("uses integer paise and rejects invalid precision", () => {
  const result = diagnoseAccountingConsistency({ b: [
    { id: 10, p: 0.3, pays: [{ a: 0.1 }, { a: 0.2 }] },
    { id: 11, p: 1, pays: [{ a: 0.001 }] }
  ] });
  assert.equal(result.affectedBookingCount, 0);
  assert.equal(result.malformedBookingCount, 1);
});


test("does not mutate active or cancelled booking state", () => {
  const state = {
    b: [{ id: 12, p: 9, pays: [{ a: 4 }], payments: [{ amount: 4 }] }],
    cancelled: [{ id: 13, p: 0, pays: [{ a: 1 }] }]
  };
  const before = structuredClone(state);
  diagnoseAccountingConsistency(state);
  assert.deepEqual(state, before);
});

test("treats missing paid total and missing payment rows as zero", () => {
  const result = diagnoseAccountingConsistency({ b: [{ id: 14 }] });
  assert.equal(result.affectedBookingCount, 0);
  assert.equal(result.malformedBookingCount, 0);
});

test("ranks the largest absolute discrepancies first", () => {
  const result = diagnoseAccountingConsistency({ b: [
    { id: 15, p: 1, pays: [] },
    { id: 16, p: 100, pays: [] },
    { id: 17, p: 5, pays: [] }
  ] }, { worstLimit: 2 });
  assert.deepEqual(result.worst.map(row => row.bookingId), [16, 17]);
});


test("detects duplicate payment idempotency keys within a booking", () => {
  const result = diagnoseAccountingConsistency({ b: [{
    id: 20, p: 20, pays: [
      { a: 10, idempotencyKey: "gateway:event-1" },
      { a: 10, idempotencyKey: "gateway:event-1" }
    ]
  }] });
  assert.equal(result.duplicatePaymentCount, 1);
  assert.equal(result.duplicates[0].reason, "duplicate_payment_within_booking");
});

test("detects a payment reference reused across two bookings", () => {
  const result = diagnoseAccountingConsistency({ b: [
    { id: 21, p: 10, pays: [{ a: 10, r: "UTR-123" }] },
    { id: 22, p: 10, pays: [{ a: 10, r: "utr-123" }] }
  ] });
  assert.equal(result.duplicatePaymentCount, 1);
  assert.equal(result.duplicates[0].reason, "payment_reference_reused_across_bookings");
});

test("detects orphaned or mis-keyed reservation advances", () => {
  const result = diagnoseAccountingConsistency({ b: [{
    id: 23, p: 10, pays: [
      { a: 5, source: "reservation_advance", bookingId: 999, idempotencyKey: "booking-advance:999" },
      { a: 5, source: "reservation_advance", bookingId: 23, idempotencyKey: "wrong-key" }
    ]
  }] });
  assert.equal(result.orphanAdvanceCount, 3);
});

test("detects refunds greater than the recorded original payment", () => {
  const result = diagnoseAccountingConsistency({ cancelled: [{
    id: 24, p: 25, pays: [{ a: 25 }], original_amount_paid: 25, refund_amount: 30
  }] });
  assert.equal(result.refundOverpaymentCount, 1);
  assert.equal(result.refundOverpayments[0].excessPaise, 500);
});

test("reports negative and malformed refund amounts without modifying state", () => {
  const state = { cancelled: [
    { id: 25, p: 10, pays: [{ a: 10 }], refund_amount: -1 },
    { id: 26, p: 10, pays: [{ a: 10 }], refund_amount: "not-money" }
  ] };
  const before = structuredClone(state);
  const result = diagnoseAccountingConsistency(state);
  assert.equal(result.refundOverpaymentCount, 0);
  assert.equal(result.malformedBookingCount, 2);
  assert.deepEqual(state, before);
});

test("does not double count the intentional payments history mirror", () => {
  const result = diagnoseAccountingConsistency({ b: [{
    id: 27, p: 15,
    pays: [{ a: 15, r: "UTR-27" }],
    payments: [{ amount: 15, reference: "UTR-27" }]
  }] });
  assert.equal(result.duplicatePaymentCount, 0);
  assert.equal(result.affectedBookingCount, 0);
});


test("detects reservation advances with a missing idempotency key", () => {
  const result = diagnoseAccountingConsistency({ b: [{
    id: 28, p: 10, pays: [
      { a: 10, source: "reservation_advance" }
    ]
  }] });
  assert.equal(result.orphanAdvanceCount, 1);
});

test("detects negative and excessive-precision payment rows", () => {
  const result = diagnoseAccountingConsistency({ b: [
    { id: 29, p: 0, pays: [{ a: -1 }] },
    { id: 30, p: 0, pays: [{ a: 1.001 }] }
  ] });
  assert.equal(result.malformedBookingCount, 2);
  assert.equal(result.affectedBookingCount, 0);
});


test("detects canonical payment identity reused through a different reference", () => {
  const result = diagnoseAccountingConsistency({ b: [{
    id: 31, p: 20, pays: [
      { a: 10, r: "UTR-A", idempotencyKey: "intent-1" },
      { a: 10, r: "UTR-B", idempotencyKey: "intent-1" }
    ]
  }] });
  assert.equal(result.duplicatePaymentCount, 1);
  assert.equal(result.duplicates[0].fingerprint, "idempotency:intent-1");
});

test("detects booking id reuse and missing booking identifiers", () => {
  const result = diagnoseAccountingConsistency({
    b: [{ id: "same", p: 0, pays: [] }, { p: 0, pays: [] }],
    cancelled: [{ id: "same", p: 0, pays: [] }]
  });
  assert.equal(result.duplicateBookingIdCount, 1);
  assert.equal(result.missingBookingIdCount, 1);
});

test("detects compatibility history rows that do not mirror canonical payment rows", () => {
  const result = diagnoseAccountingConsistency({ b: [{
    id: 32, p: 10,
    pays: [{ a: 10, amountPaise: 1000, m: "UPI", r: "UTR-32", source: "manual", bookingId: 32 }],
    payments: [{ amount: 9, amountPaise: 900, method: "UPI", reference: "UTR-32", source: "manual", bookingId: 32 }]
  }] });
  assert.equal(result.historyMismatchCount, 1);
  assert.equal(result.historyMismatches[0].missingFromHistoryCount, 1);
  assert.equal(result.historyMismatches[0].extraInHistoryCount, 1);
});

test("continues scanning later payment rows after a malformed row", () => {
  const result = diagnoseAccountingConsistency({ b: [{
    id: 33, p: 20, pays: [
      { a: "bad" },
      { a: 10, r: "DUP" },
      { a: 10, r: "DUP" }
    ]
  }] });
  assert.equal(result.malformedBookingCount, 1);
  assert.equal(result.duplicatePaymentCount, 1);
});

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("accounting diagnostic CLI parses and strict mode reports ledger findings", () => {
  const dir = mkdtempSync(join(tmpdir(), "aurelia-accounting-"));
  try {
    const cleanPath = join(dir, "clean.json");
    const driftPath = join(dir, "drift.json");
    writeFileSync(cleanPath, JSON.stringify({ b: [{ id: "B-1", p: 0, pays: [], payments: [] }], cancelled: [] }));
    writeFileSync(driftPath, JSON.stringify({ b: [{ id: "B-1", p: 10, pays: [], payments: [] }], cancelled: [] }));
    const clean = spawnSync(process.execPath, ["scripts/diagnose-accounting.mjs", cleanPath, "--strict"], { encoding: "utf8" });
    const drift = spawnSync(process.execPath, ["scripts/diagnose-accounting.mjs", driftPath, "--strict"], { encoding: "utf8" });
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(drift.status, 2, drift.stderr);
    assert.match(drift.stdout, /"affectedBookingCount": 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("valid balanced cancellation journals pass the financial-ledger audit", () => {
  const result = diagnoseAccountingConsistency({
    b: [],
    cancelled: [{ id: 40, refundPayableJournalRecorded: true, cancelledStatus: "refund_pending", refund_amount: 400 }],
    financialLedger: [{
      id: "JE-40", reference: "CANCEL-40", kind: "refund_pending", bookingId: 40,
      lines: [
        { account: "Guest Advances Liability", debit: 400, credit: 0 },
        { account: "Refunds Payable Liability", debit: 0, credit: 400 }
      ]
    }]
  });
  assert.equal(result.malformedJournalCount, 0);
  assert.equal(result.unbalancedJournalCount, 0);
  assert.equal(result.cancellationFlagMismatchCount, 0);
});

test("detects unbalanced and malformed cancellation journal lines", () => {
  const result = diagnoseAccountingConsistency({
    financialLedger: [
      { id: "JE-41", reference: "CANCEL-41", kind: "cancellation_settlement", bookingId: 41,
        lines: [{ account: "Cash", debit: 100, credit: 0 }, { account: "Revenue", debit: 0, credit: 90 }] },
      { id: "JE-42", reference: "CANCEL-42", kind: "refund_pending", bookingId: 42,
        lines: [{ account: "", debit: -1, credit: 0 }] }
    ]
  });
  assert.equal(result.unbalancedJournalCount, 1);
  assert.equal(result.malformedJournalCount, 1);
});

test("detects duplicate journal identities and duplicate cancellation postings", () => {
  const result = diagnoseAccountingConsistency({
    financialLedger: [
      { id: "JE-DUP", reference: "CANCEL-43", kind: "refund_pending", bookingId: 43,
        lines: [{ account: "Guest Advances", debit: 10, credit: 0 }, { account: "Refund Payable", debit: 0, credit: 10 }] },
      { id: "JE-DUP", reference: "CANCEL-43", kind: "refund_pending", bookingId: 43,
        lines: [{ account: "Guest Advances", debit: 10, credit: 0 }, { account: "Refund Payable", debit: 0, credit: 10 }] }
    ]
  });
  assert.equal(result.duplicateJournalIdCount, 1);
  assert.equal(result.duplicateCancellationPostingCount, 1);
});

test("detects cancellation status flags without matching journal evidence", () => {
  const result = diagnoseAccountingConsistency({
    cancelled: [{
      id: 44, cancellationAccountingCommitted: true, refundPayableJournalRecorded: true,
      cancelledStatus: "refunded", refund_amount: 50
    }],
    financialLedger: []
  });
  assert.equal(result.cancellationFlagMismatchCount, 4);
});

test("strict diagnostic CLI exits non-zero for cancellation journal integrity findings", () => {
  const dir = mkdtempSync(join(tmpdir(), "aurelia-accounting-journal-"));
  try {
    const path = join(dir, "journal-drift.json");
    writeFileSync(path, JSON.stringify({
      b: [], cancelled: [],
      financialLedger: [{
        id: "JE-45", reference: "CANCEL-45", kind: "cancellation_settlement", bookingId: 45,
        lines: [{ account: "Cash", debit: 10, credit: 0 }]
      }]
    }));
    const result = spawnSync(process.execPath, ["scripts/diagnose-accounting.mjs", path, "--strict"], { encoding: "utf8" });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stdout, /"unbalancedJournalCount": 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reports non-positive integer-paise values in compatibility history rows", () => {
  const result = diagnoseAccountingConsistency({
    b: [{
      id: 46, p: 0, pays: [],
      payments: [{ amountPaise: 0, amount: 0, method: "UPI" }]
    }]
  });
  assert.equal(result.malformedBookingCount, 1);
  assert.equal(result.historyMismatchCount, 0);
  assert.equal(result.malformed[0].reason.startsWith("invalid_history_payment_row:"), true);
});

test("treats a null financial ledger as malformed rather than as an empty ledger", () => {
  const result = diagnoseAccountingConsistency({ b: [], cancelled: [], financialLedger: null });
  assert.equal(result.malformedJournalCount, 1);
  assert.equal(result.journalMalformed[0].reason, "financial_ledger_not_array");
});

test("detects paid refund flags without independent settlement evidence", () => {
  const result = diagnoseAccountingConsistency({
    cancelled: [{
      id: 47, refund_amount: 25, cancelledStatus: "partially_refunded",
      refund_settlement_confirmed: false, refund_transaction_reference: ""
    }],
    financialLedger: [{
      id: "JE-47", reference: "CANCEL-47", kind: "cancellation_settlement", bookingId: 47,
      lines: [{ account: "Guest Advances", debit: 25, credit: 0 }, { account: "Cash & Bank", debit: 0, credit: 25 }]
    }]
  });
  assert.equal(result.cancellationFlagMismatchCount, 1);
  assert.equal(result.cancellationFlagMismatches[0].reason, "paid_refund_missing_settlement_evidence");
});

test("zero-value cancellations without journal lines are not falsely marked committed", () => {
  const result = diagnoseAccountingConsistency({
    b: [],
    cancelled: [{ id: 48, p: 0, pays: [], refund_amount: 0, cancelledStatus: "no_refund", cancellationAccountingCommitted: false }],
    financialLedger: []
  });
  assert.equal(result.cancellationFlagMismatchCount, 0);
  assert.equal(result.malformedJournalCount, 0);
});

test("detects a cancellation reference reused across different booking identities", () => {
  const entry = bookingId => ({
    id: "JE-" + bookingId, reference: "CANCEL-SHARED", kind: "cancellation_settlement", bookingId,
    lines: [{ account: "Guest Advances", debit: 10, credit: 0 }, { account: "Cancellation Revenue", debit: 0, credit: 10 }]
  });
  const result = diagnoseAccountingConsistency({ b: [], cancelled: [], financialLedger: [entry(49), entry(50)] });
  assert.equal(result.duplicateCancellationPostingCount, 1);
  assert.equal(result.duplicateCancellationPostings[0].reason, "cancellation_reference_reused_across_bookings");
});

test("pending refund liability must equal the booking refund amount", () => {
  const result = diagnoseAccountingConsistency({
    b: [], cancelled: [{ id: 51, refund_amount: 400, cancelledStatus: "refund_pending", refundPayableJournalRecorded: true }],
    financialLedger: [{
      id: "JE-51", reference: "CANCEL-51", kind: "refund_pending", bookingId: 51,
      lines: [
        { account: "Guest Advances Liability", debit: 500, credit: 0 },
        { account: "Refunds Payable Liability", debit: 0, credit: 500 }
      ]
    }]
  });
  assert.equal(result.cancellationFlagMismatchCount, 1);
  assert.equal(result.cancellationFlagMismatches[0].reason, "pending_refund_amount_does_not_match_liability");
});

test("paid refund cash journal must equal the booking refund amount", () => {
  const result = diagnoseAccountingConsistency({
    b: [],
    cancelled: [{
      id: 52, refund_amount: 400, cancelledStatus: "refunded",
      refund_settlement_confirmed: true, refund_transaction_reference: "BANK-UTR-52"
    }],
    financialLedger: [{
      id: "JE-52", reference: "CANCEL-52", kind: "cancellation_settlement", bookingId: 52,
      lines: [
        { account: "Guest Advances Liability", debit: 500, credit: 0 },
        { account: "Cash & Bank", debit: 0, credit: 450 },
        { account: "Cancellation Revenue", debit: 0, credit: 50 }
      ]
    }]
  });
  assert.equal(result.cancellationFlagMismatchCount, 1);
  assert.equal(result.cancellationFlagMismatches[0].reason, "paid_refund_amount_does_not_match_journal");
});

test("pending refund journal recognizes retained cancellation revenue exactly once", () => {
  const result = diagnoseAccountingConsistency({
    b: [],
    cancelled: [{
      id: 53, original_amount_paid: 1000, refund_amount: 400,
      retention_fee_retained: 600, cancelledStatus: "refund_pending",
      refundPayableJournalRecorded: true
    }],
    financialLedger: [{
      id: "JE-53", reference: "CANCEL-53", kind: "refund_pending", bookingId: 53,
      lines: [
        { account: "Guest Advances Liability", debit: 1000, credit: 0 },
        { account: "Refunds Payable Liability", debit: 0, credit: 400 },
        { account: "Cancellation Revenue", debit: 0, credit: 600 }
      ]
    }]
  });
  assert.equal(result.cancellationFlagMismatchCount, 0);
  const missingRetention = diagnoseAccountingConsistency({
    b: [],
    cancelled: [{
      id: 54, original_amount_paid: 1000, refund_amount: 400,
      retention_fee_retained: 600, cancelledStatus: "refund_pending",
      refundPayableJournalRecorded: true
    }],
    financialLedger: [{
      id: "JE-54", reference: "CANCEL-54", kind: "refund_pending", bookingId: 54,
      lines: [
        { account: "Guest Advances Liability", debit: 400, credit: 0 },
        { account: "Refunds Payable Liability", debit: 0, credit: 400 }
      ]
    }]
  });
  assert.equal(missingRetention.cancellationFlagMismatchCount, 1);
  assert.equal(missingRetention.cancellationFlagMismatches[0].reason,
    "pending_refund_retention_does_not_match_journal");
});


test("accounting diagnostic CLI redacts record identifiers and payment references by default", () => {
  const dir = mkdtempSync(join(tmpdir(), "aurelia-accounting-redacted-"));
  try {
    const path = join(dir, "private-backup.json");
    writeFileSync(path, JSON.stringify({
      b: [{ id: "PRIVATE-BOOKING-91", g: "PRIVATE-GUEST-NAME", room: "ROOM-SECRET",
        p: 10, pays: [{ a: 5, r: "UTR-SECRET-991", idempotencyKey: "IDEMPOTENCY-SECRET" }] }],
      cancelled: []
    }));
    const result = spawnSync(process.execPath, ["scripts/diagnose-accounting.mjs", path], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"privacy": "REDACTED_SUMMARY"/);
    for (const secret of ["PRIVATE-BOOKING-91", "PRIVATE-GUEST-NAME", "ROOM-SECRET", "UTR-SECRET-991", "IDEMPOTENCY-SECRET"]) {
      assert.equal(result.stdout.includes(secret), false, "default report leaked " + secret);
    }
    assert.match(result.stdout, /"affectedBookingCount": 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("private accounting report requires an explicit local opt-in", () => {
  const dir = mkdtempSync(join(tmpdir(), "aurelia-accounting-private-"));
  try {
    const path = join(dir, "private-backup.json");
    writeFileSync(path, JSON.stringify({
      b: [{ id: "PRIVATE-BOOKING-92", p: 6, pays: [{ a: 5, r: "UTR-PRIVATE-92" }] }],
      cancelled: []
    }));
    const result = spawnSync(process.execPath, ["scripts/diagnose-accounting.mjs", path, "--private-report"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"privacy": "PRIVATE_ROW_LEVEL_REPORT"/);
    assert.match(result.stdout, /PRIVATE-BOOKING-92/);
    assert.match(result.stdout, /UTR-PRIVATE-92/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
