import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { settlePayment } from "../src/payments/settlement-service.mjs";
import { PAYMENT_SAFETY_LOCKS } from "../src/payments/payment-safety-gate.mjs";

function fixture() {
  const booking = { id: 17, room: "A1", p: 25, pays: [], payments: [] };
  const state = { b: [booking], today: 0, aud: [] };
  let persistCalls = 0, auditCalls = 0;
  return {
    booking, state,
    get persistCalls() { return persistCalls; },
    get auditCalls() { return auditCalls; },
    input: {
      state, booking, amount: 10, method: "Cash", balanceDue: 100,
      verificationConfirmed: true,
      persist: () => { persistCalls += 1; },
      audit: () => { auditCalls += 1; }
    }
  };
}

test("offline manual folio operations remain enabled while gateway controls stay locked", () => {
  assert.deepEqual(PAYMENT_SAFETY_LOCKS, {
    blockAllBalanceMutations: false,
    automaticSettlement: true,
    liveCollection: true,
    nativeSettlementBridge: true
  });
});

test("manual cash, staff-reviewed and reservation-advance payments post locally", () => {
  for (const source of ["manual", "staff_review", "reservation_advance"]) {
    const app = fixture();
    const result = settlePayment({ ...app.input, source });
    assert.equal(result.ok, true);
    assert.equal(result.duplicate, false);
    assert.equal(app.booking.p, 35);
    assert.equal(app.booking.pays.length, 1);
    assert.equal(app.booking.payments.length, 1);
    assert.equal(app.booking.pays[0].verificationConfirmed, true);
    assert.equal(app.state.today, 10);
    assert.equal(app.persistCalls, 1);
    assert.equal(app.auditCalls, 1);
  }
});

test("automatic and gateway settlement remain fail-closed", () => {
  const automatic = fixture();
  assert.throws(
    () => settlePayment({ ...automatic.input, source: "auto" }),
    error => error.code === "AUTO_SETTLEMENT_DISABLED"
  );
  assert.equal(automatic.booking.p, 25);
  assert.equal(automatic.booking.pays.length, 0);
  const gateway = fixture();
  assert.throws(
    () => settlePayment({ ...gateway.input, source: "verified_gateway" }),
    error => error.code === "AUTO_SETTLEMENT_KILL_SWITCH"
  );
  assert.equal(gateway.booking.p, 25);
  assert.equal(gateway.booking.pays.length, 0);
});

test("manual payment idempotency returns the original posting without double counting", () => {
  const app = fixture();
  const first = settlePayment({ ...app.input, source: "manual", idempotencyKey: "manual-payment-123" });
  const replay = settlePayment({ ...app.input, source: "manual", idempotencyKey: "manual-payment-123" });
  assert.equal(first.ok, true);
  assert.equal(replay.duplicate, true);
  assert.equal(app.booking.p, 35);
  assert.equal(app.booking.pays.length, 1);
  assert.equal(app.booking.payments.length, 1);
  assert.equal(app.persistCalls, 1);
});

test("invalid manual amounts are rejected before any write", () => {
  const app = fixture();
  assert.throws(
    () => settlePayment({ ...app.input, amount: -1, source: "manual" }),
    RangeError
  );
  assert.equal(app.booking.p, 25);
  assert.equal(app.booking.pays.length, 0);
  assert.equal(app.persistCalls, 0);
  assert.equal(app.auditCalls, 0);
});

test("addSig is evidence-only and keeps suggested matches in review", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const start = html.indexOf("function addSig(o)");
  const end = html.indexOf("\nwindow.aureliaNativePaymentSignal", start);
  assert.ok(start >= 0 && end > start, "addSig handler must exist");
  const handler = html.slice(start, end);
  assert.doesNotMatch(handler, /addPay\s*\(|settlePayment\s*\(/);
  assert.match(handler, /pending_review/);
  assert.match(handler, /suggestedBookingId/);
});

test("manual UI and staff apply use the single guarded settlement boundary", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const staffStart = html.indexOf("function sigA(");
  const staffEnd = html.indexOf("\n/* money flow */", staffStart);
  assert.ok(staffStart >= 0 && staffEnd > staffStart);
  const staffReview = html.slice(staffStart, staffEnd);
  assert.match(staffReview, /await settlePayment\(/);
  assert.match(staffReview, /evidenceId:id/);
  assert.doesNotMatch(staffReview, /await persistCanonicalStrict\(\)/);
  assert.match(html, /source:'manual'/);
  assert.match(html, /source:'staff_review'/);
});

test("reservation advance form retains amount validation and rollback checks", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const start = html.indexOf("async function dsave(){");
  const end = html.indexOf("\nfunction cin(i)", start);
  assert.ok(start >= 0 && end > start);
  const handler = html.slice(start, end);
  assert.match(handler, /Advance cannot exceed the room charges/);
  assert.match(handler, /no more than two decimal places/);
  assert.match(handler, /priorBookings/);
  assert.match(handler, /Guest or reservation could not be verified in device storage/);
  assert.match(handler, /S\.b=priorBookings/);
  assert.match(handler, /await adapter\.commitReservation\(/);
  assert.match(handler, /await adapter\.commitGuestMutation\(/);
  assert.match(handler, /return withLocalOperationalLock\(async\(\)=>/);
  assert.doesNotMatch(handler, /persistCanonicalStrict/);
  assert.doesNotMatch(handler, /\n\s*persist\(\);/);
});
