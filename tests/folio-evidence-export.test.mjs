import test from "node:test";
import assert from "node:assert/strict";
import { buildFolioEvidenceExport } from "../scripts/export-folio-evidence.mjs";

const digest = "a".repeat(64);
const snapshot = () => ({
  rooms: [
    { n: "101", r: 1200 },
    { n: "102", r: 1000 },
    { n: "103", r: 900 }
  ],
  b: [
    {
      id: 1, g: "PRIVATE GUEST ONE", ph: "9999999999", room: "101", in: 1, out: 2,
      st: "done", rate: 1200, ch: [], dc: 0, p: 1200,
      pays: [{ a: 1200, amountPaise: 120000, m: "Cash", source: "manual", at: "2026-11-09T10:00:00.000Z", verificationConfirmed: true, bookingId: 1 }],
      payments: [{ amountPaise: 120000, method: "Cash", source: "manual", date: "2026-11-09T10:00:00.000Z" }]
    },
    {
      id: 2, g: "PRIVATE GUEST TWO", ph: "8888888888", room: "102", in: 1, out: 3,
      st: "in", rate: 1000, ch: [], dc: 0, p: 1000,
      pays: [{ amountPaise: 100000, m: "UPI", r: "UTR-ABC-123456", source: "staff_review", at: "2026-11-09T11:00:00.000Z", verificationConfirmed: true, bookingId: 2 }],
      payments: [{ amountPaise: 100000, method: "UPI", source: "staff_review", date: "2026-11-09T11:00:00.000Z" }]
    },
    {
      id: 3, g: "PRIVATE GUEST THREE", ph: "7777777777", room: "103", in: 1, out: 2,
      st: "res", rate: 900, ch: [["Dinner", 200]], dc: 0, p: 0, pays: [], payments: []
    }
  ],
  sig: [{ id: "evidence-2", b: 2, st: "matched", amt: 1000, ref: "UTR-ABC-123456", approvedAt: "2026-11-09T11:05:00.000Z" }]
});

test("read-only evidence export classifies real-shaped payment rows and mirrors UI balance math", () => {
  const state = snapshot(), before = JSON.stringify(state);
  const report = buildFolioEvidenceExport(state, digest);
  assert.deepEqual(report.counts, {
    activeBookings: 3, manualCashBookings: 1, staffReviewedUpiBookings: 1,
    unpaidBalanceBookings: 2, legacyPaymentFoliosPresent: null
  });
  assert.equal(report.groups.manualCash[0].bookingId, "1");
  assert.equal(report.groups.staffReviewedUpi[0].bookingId, "2");
  assert.equal(report.groups.staffReviewedUpi[0].staffReviewEvidence[0].evidenceId, "evidence-2");
  assert.deepEqual(report.groups.staffReviewedUpi[0].pays[0].reference, { last4: "3456", length: 14 });
  assert.equal(report.groups.unpaidBalance[0].totalPaise, 110000);
  assert.equal(report.groups.unpaidBalance[0].balanceDuePaise, 110000);
  assert.equal(JSON.stringify(state), before, "export must not mutate the source snapshot");
  const encoded = JSON.stringify(report);
  assert.doesNotMatch(encoded, /PRIVATE GUEST|9999999999|8888888888|7777777777|UTR-ABC-123456/);
  assert.match(encoded, /"paidTotalUsedByRunningBalance": "booking.p"/);
});

test("evidence export rejects malformed booking inputs instead of silently treating them as zero", () => {
  const invalid = snapshot();
  delete invalid.b[0].ch;
  assert.throws(() => buildFolioEvidenceExport(invalid, digest), /charge collection/);
  assert.throws(() => buildFolioEvidenceExport(snapshot(), "not-a-digest"), /SHA-256/);
});

test("evidence export rejects malformed payment rows and negative amounts", () => {
  const invalid = snapshot();
  invalid.b[0].pays = [{ amountPaise: -1, m: "Cash" }];
  assert.throws(() => buildFolioEvidenceExport(invalid, digest), /positive safe integer paise/);
});
