import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { settlePayment } from "../src/payments/settlement-service.mjs";
import { AUTO_FOLIO_SETTLEMENT_ENABLED, assertAutoFolioSettlementEnabled } from "../src/payments/settlement-gate.mjs";

function fixture({ paid = 0, pays = [] } = {}) {
  const booking = { id: 17, room: "A1", p: paid, pays, payments: [] };
  const state = { b: [booking], today: 0, aud: [] };
  const deps = {
    state, booking, balanceDue: 1000,
    persist: () => {},
    audit: (a, d) => state.aud.unshift({ a, d }),
    assertAutoFolioSettlementEnabled
  };
  return { booking, state, deps };
}

test("manual settlement updates payment rows, paid total, history, daily total and audit once", () => {
  const { booking, state, deps } = fixture();
  const result = settlePayment({ ...deps, amount: 250, method: "Cash", source: "manual" });
  assert.equal(result.ok, true);
  assert.equal(result.duplicate, false);
  assert.equal(booking.pays.length, 1);
  assert.equal(booking.p, 250);
  assert.equal(booking.payments.length, 1);
  assert.equal(state.today, 250);
  assert.equal(state.aud.length, 1);
});

test("staff review settlement records a UPI payment", () => {
  const { booking, deps } = fixture();
  const result = settlePayment({
    ...deps, amount: 300, method: "UPI", reference: "UTR-123",
    source: "staff_review", idempotencyKey: "utr:UTR-123"
  });
  assert.equal(result.ok, true);
  assert.equal(booking.p, 300);
  assert.equal(booking.pays[0].source, "staff_review");
});

test("same idempotency key or UTR cannot post twice", () => {
  const { booking, state, deps } = fixture();
  const input = { ...deps, amount: 300, method: "UPI", reference: "UTR-456", source: "staff_review", idempotencyKey: "utr:UTR-456" };
  assert.equal(settlePayment(input).duplicate, false);
  assert.equal(settlePayment(input).duplicate, true);
  assert.equal(booking.pays.length, 1);
  assert.equal(booking.payments.length, 1);
  assert.equal(state.today, 300);
});

test("same idempotency key with changed amount or method is rejected", () => {
  const { deps } = fixture();
  const input = { ...deps, amount: 300, method: "UPI", reference: "UTR-456", source: "staff_review", idempotencyKey: "utr:UTR-456" };
  settlePayment(input);
  assert.throws(() => settlePayment({ ...input, amount: 301 }), error => error.code === "IDEMPOTENCY_KEY_CONFLICT");
  assert.throws(() => settlePayment({ ...input, method: "Cash" }), error => error.code === "IDEMPOTENCY_KEY_CONFLICT");
});

test("idempotency key cannot be reused across different bookings", () => {
  const { booking, state, deps } = fixture();
  settlePayment({ ...deps, amount: 300, method: "UPI", source: "manual", idempotencyKey: "request-unique-123" });
  const other = { id: 18, room: "A2", p: 0, pays: [], payments: [] };
  state.b.push(other);
  assert.throws(() => settlePayment({
    ...deps, booking: other, amount: 300, method: "UPI", source: "manual",
    idempotencyKey: "request-unique-123", balanceDue: 1000
  }), error => error.code === "IDEMPOTENCY_KEY_CONFLICT");
});

test("legacy paid total is preserved when old payment rows are missing", () => {
  const { booking, deps } = fixture({ paid: 125, pays: [] });
  settlePayment({ ...deps, amount: 25, method: "Cash" });
  assert.equal(booking.p, 150);
  assert.equal(booking.pays.reduce((sum, row) => sum + row.a, 0), 25);
});

test("INR payments require paise precision and a valid balance", () => {
  const { booking, state, deps } = fixture();
  assert.throws(() => settlePayment({ ...deps, amount: 10.001, method: "Cash" }), /two decimal places/);
  assert.throws(() => settlePayment({ ...deps, amount: 10, method: "Cash", balanceDue: undefined }), /Balance due/);
  assert.throws(() => settlePayment({ ...deps, amount: 10, method: "Cash", balanceDue: Number.NaN }), /Balance due/);
  assert.equal(booking.p, 0);
  assert.equal(state.today, 0);
});

test("overpayment is rejected without changing balances", () => {
  const { booking, state, deps } = fixture();
  assert.throws(() => settlePayment({ ...deps, amount: 1001, method: "Cash", source: "manual" }), /exceeds the balance/i);
  assert.equal(booking.pays.length, 0);
  assert.equal(booking.p, 0);
  assert.equal(state.today, 0);
});

test("persistence failure rolls in-memory payment state back", () => {
  const { booking, state, deps } = fixture();
  let calls = 0;
  assert.throws(() => settlePayment({
    ...deps, amount: 100, method: "Cash", source: "manual",
    persist: () => { calls++; if (calls === 1) throw new Error("storage failure"); }
  }), /storage failure/);
  assert.equal(booking.pays.length, 0);
  assert.equal(booking.p, 0);
  assert.equal(booking.payments.length, 0);
  assert.equal(state.today, 0);
  assert.equal(state.aud.length, 0);
});

test("automatic source calls the gate and cannot mutate while disabled", () => {
  const { booking, state, deps } = fixture();
  assert.equal(AUTO_FOLIO_SETTLEMENT_ENABLED, false);
  assert.throws(() => settlePayment({
    ...deps, amount: 100, method: "UPI", source: "auto",
    idempotencyKey: "auto-1"
  }), /automatic folio settlement is disabled/i);
  assert.equal(booking.pays.length, 0);
  assert.equal(booking.p, 0);
  assert.equal(booking.payments.length, 0);
  assert.equal(state.today, 0);
  assert.equal(state.aud.length, 0);
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

test("manual UI and staff apply call the settlement boundary", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const staffStart = html.indexOf("function sigA(");
  const staffEnd = html.indexOf("\n/* money flow */", staffStart);
  assert.ok(staffStart >= 0 && staffEnd > staffStart);
  assert.match(html.slice(staffStart, staffEnd), /settlePayment\(/);
  assert.match(html, /source:'manual'/);
  assert.match(html, /source:'staff_review'/);
});
