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

test("local accounting controls remain hard-locked regardless of cloud control flags", () => {
  assert.deepEqual(PAYMENT_SAFETY_LOCKS, {
    blockAllBalanceMutations: true,
    automaticSettlement: true,
    liveCollection: true,
    nativeSettlementBridge: true
  });
});

test("manual, staff-reviewed, reservation-advance and automatic posting all fail before mutation", () => {
  for (const source of ["manual", "staff_review", "reservation_advance", "auto"]) {
    const app = fixture();
    assert.throws(
      () => settlePayment({ ...app.input, source }),
      error => error.code === "ACCOUNTING_READ_ONLY_KILL_SWITCH"
    );
    assert.equal(app.booking.p, 25);
    assert.deepEqual(app.booking.pays, []);
    assert.deepEqual(app.booking.payments, []);
    assert.equal(app.state.today, 0);
    assert.deepEqual(app.state.aud, []);
    assert.equal(app.persistCalls, 0);
    assert.equal(app.auditCalls, 0);
  }
});

test("idempotent replay is also rejected while accounting is frozen", () => {
  const app = fixture();
  assert.throws(
    () => settlePayment({ ...app.input, source: "manual", idempotencyKey: "existing-payment-123" }),
    error => error.code === "ACCOUNTING_READ_ONLY_KILL_SWITCH"
  );
  assert.equal(app.booking.p, 25);
  assert.equal(app.booking.pays.length, 0);
});

test("the global freeze is evaluated before input validation and before any write", () => {
  const app = fixture();
  assert.throws(
    () => settlePayment({ state: app.state, booking: app.booking, amount: -1 }),
    error => error.code === "ACCOUNTING_READ_ONLY_KILL_SWITCH"
  );
  assert.equal(app.booking.p, 25);
  assert.equal(app.booking.pays.length, 0);
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
  assert.match(html.slice(staffStart, staffEnd), /settlePayment\(/);
  assert.match(html, /source:'manual'/);
  assert.match(html, /source:'staff_review'/);
});

test("reservation advance form retains amount validation and rollback checks", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const start = html.indexOf("function dsave(){");
  const end = html.indexOf("\nfunction cin(i)", start);
  assert.ok(start >= 0 && end > start);
  const handler = html.slice(start, end);
  assert.match(handler, /Advance cannot exceed the room charges/);
  assert.match(handler, /no more than two decimal places/);
  assert.match(handler, /priorBookings/);
  assert.match(handler, /Guest or reservation could not be verified in device storage/);
  assert.match(handler, /S\.b=priorBookings/);
});


test("legacy direct checkout and restaurant settlement mutators are fail-closed", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /function out\(i,T\)\{toast\('Direct check-out settlement is disabled/);
  assert.equal((html.match(/function settleGo\(\)\{toast\('Legacy restaurant settlement is disabled/g)||[]).length, 2);
  assert.match(html, /function settle\(\)\{toast\('Legacy table settlement is disabled/);
  assert.match(html, /function recordRestPay\(\)/);
});
