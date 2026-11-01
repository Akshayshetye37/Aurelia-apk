import test from "node:test";
import assert from "node:assert/strict";
import {
  PAYMENT_STATES, PayBridgePaymentOrchestrator, PaymentOrchestratorError,
  createPaymentBackendClient, transitionPayment
} from "../src/payments/pay-bridge-orchestrator.mjs";

function fixture({ connected = true, backendOverrides = {} } = {}) {
  const records = new Map();
  const store = {
    async put(r) { records.set(r.requestId, structuredClone(r)); },
    async get(k) { return records.has(k) ? structuredClone(records.get(k)) : null; },
    async listPending() { return [...records.values()].filter(r => !["SUCCESS","FAILED","CANCELLED"].includes(r.state)); }
  };
  const bridge = {
    isAuthenticated: () => connected,
    async createPayment(p) { return { requestId: p.requestId, transactionId: "txn-1", status: "processing" }; },
    async getPaymentStatus() { return { status: "processing" }; },
    async cancelPayment(p) { return { requestId: p.requestId, status: "cancelled" }; }
  };
  const backend = {
    async createSession(p) { return { requestId: p.requestId, sessionId: "sess-1", bookingId: p.bookingId, folioId: p.folioId, amountPaise: p.amountPaise, currency: p.currency, providerId: p.providerId }; },
    async verifyPayment(p) { return { verified: true, status: "success", requestId: p.requestId, sessionId: p.sessionId, providerId: p.providerId, bookingId: p.bookingId, amountPaise: p.amountPaise, currency: p.currency, folioId: p.folioId, transactionId: "txn-1" }; },
    async getPaymentStatus() { return { status: "processing" }; },
    async reconcile(p) { return { verified: true, status: "processing", requestId: p.requestId, sessionId: p.sessionId, providerId: p.providerId, bookingId: p.bookingId, amountPaise: p.amountPaise, currency: p.currency, folioId: p.folioId }; },
    ...backendOverrides
  };
  return { store, bridge, backend, records, orchestrator: new PayBridgePaymentOrchestrator({ store, bridge, backend }) };
}
const input = { requestId:"req-1", bookingId:"booking-1", folioId:"folio-1", amountPaise:12500, currency:"INR", providerId:"razorpay" };

test("payment persists before bridge availability and disconnected PMS remains usable", async () => {
  const f = fixture({ connected:false });
  await assert.rejects(f.orchestrator.createPayment(input), e => e.code === "BRIDGE_DISCONNECTED");
  assert.equal((await f.store.get("req-1")).state, PAYMENT_STATES.CREATED);
});

test("bridge processing is not settlement authorization; backend verification is required", async () => {
  const f = fixture();
  const r = await f.orchestrator.createPayment(input);
  assert.equal(r.state, "PROCESSING");
  assert.equal(r.settlementAuthorized, false);
  const event = await f.orchestrator.receiveBridgeEvent({
    requestId:"req-1", bookingId:"booking-1", amountPaise:12500, currency:"INR", folioId:"folio-1", status:"success", transactionId:"txn-1"
  });
  assert.equal(event.state, "PROCESSING");
  const verified = await f.orchestrator.verifyPayment("req-1");
  assert.equal(verified.state, "SUCCESS");
  assert.equal(verified.backendVerified, true);
  assert.equal(verified.settlementAuthorized, true);
});

test("mismatched backend verification cannot authorize settlement", async () => {
  const f = fixture({ backendOverrides: { async verifyPayment(p) { return { verified:true,status:"success",requestId:p.requestId,amountPaise:1,currency:p.currency,folioId:p.folioId,transactionId:"txn-1" }; } } });
  await f.orchestrator.createPayment(input);
  await assert.rejects(f.orchestrator.verifyPayment("req-1"), e => e.code === "BACKEND_NOT_VERIFIED");
  assert.equal((await f.store.get("req-1")).settlementAuthorized, false);
});

test("request id reuse with different amount is rejected", async () => {
  const f = fixture();
  await f.orchestrator.createPayment(input);
  await assert.rejects(f.orchestrator.createPayment({...input,amountPaise:13000}), e => e.code === "IDEMPOTENCY_CONFLICT");
});

test("events cannot be attached to a different folio or amount", async () => {
  const f = fixture();
  await f.orchestrator.createPayment(input);
  await assert.rejects(f.orchestrator.receiveBridgeEvent({requestId:"req-1",bookingId:"booking-1",amountPaise:1,currency:"INR",folioId:"folio-1",status:"success"}), e => e.code === "EVENT_BINDING_MISMATCH");
});

test("only declared state transitions are accepted", () => {
  const record = { state:"CREATED", history:[] };
  assert.throws(() => transitionPayment(record,"SUCCESS"), e => e.code === "INVALID_TRANSITION");
});

test("backend adapter rejects non-HTTPS endpoints", () => {
  assert.throws(() => createPaymentBackendClient({baseUrl:"http://localhost",getAccessToken:async()=>"token"}));
});

test("a disconnected CREATED intent can be retried after Pay Bridge reconnects", async () => {
  const f = fixture({ connected:false });
  await assert.rejects(f.orchestrator.createPayment(input), e => e.code === "BRIDGE_DISCONNECTED");
  f.bridge.isAuthenticated = () => true;
  const retried = await f.orchestrator.createPayment(input);
  assert.equal(retried.state, "PROCESSING");
  assert.equal(retried.backendSessionId, "sess-1");
});


test("an ambiguous backend session response is retained as UNKNOWN, never retried as a new checkout", async () => {
  const f = fixture({ backendOverrides: {
    async createSession() { throw Object.assign(new Error("network lost after request"), { code: "NETWORK_ERROR" }); }
  } });
  await assert.rejects(f.orchestrator.createPayment(input));
  const saved = await f.store.get("req-1");
  assert.equal(saved.state, "UNKNOWN");
  assert.equal(saved.settlementAuthorized, false);
  assert.equal(saved.lastErrorCode, "NETWORK_ERROR");
});

test("bridge failure event is only a hint and requires backend reconciliation", async () => {
  const f = fixture({ backendOverrides: {
    async reconcile(p) { return { verified:true, status:"failed", requestId:p.requestId, sessionId:p.sessionId, providerId:p.providerId, bookingId:p.bookingId, amountPaise:p.amountPaise, currency:p.currency, folioId:p.folioId }; }
  }});
  await f.orchestrator.createPayment(input);
  const result = await f.orchestrator.receiveBridgeEvent({
    requestId:"req-1", bookingId:"booking-1", folioId:"folio-1",
    amountPaise:12500, currency:"INR", status:"failed", transactionId:"txn-1"
  });
  assert.equal(result.state, "FAILED");
  assert.equal(result.backendVerified, true);
});

test("unbound backend reconciliation cannot mark a payment failed", async () => {
  const f = fixture({ backendOverrides: { async reconcile() { return { status:"failed", verified:true, requestId:"wrong-request" }; } } });
  await f.orchestrator.createPayment(input);
  const result = await f.orchestrator.reconcileOne("req-1");
  assert.equal(result.state, "PROCESSING");
});

test("backend verification must bind the exact booking", async () => {
  const f = fixture({ backendOverrides: {
    async verifyPayment(p) { return { verified:true, status:"success", requestId:p.requestId, sessionId:p.sessionId, providerId:p.providerId, bookingId:"another-booking", amountPaise:p.amountPaise, currency:p.currency, folioId:p.folioId, transactionId:"txn-1" }; }
  }});
  await f.orchestrator.createPayment(input);
  await assert.rejects(f.orchestrator.verifyPayment("req-1"), e => e.code === "BACKEND_NOT_VERIFIED");
});

test("bridge cancellation is not final until backend confirms it", async () => {
  const f = fixture({ backendOverrides: {
    async reconcile(p) { return { verified:true, status:"cancelled", requestId:p.requestId, sessionId:p.sessionId, providerId:p.providerId, bookingId:p.bookingId, amountPaise:p.amountPaise, currency:p.currency, folioId:p.folioId }; }
  }});
  await f.orchestrator.createPayment(input);
  const result = await f.orchestrator.cancelPayment("req-1");
  assert.equal(result.state, "CANCELLED");
  assert.equal(result.backendVerified, true);
});

test("backend session must bind the exact folio amount and provider", async () => {
  const f = fixture({ backendOverrides: {
    async createSession(p) { return { requestId:p.requestId, sessionId:"sess-1", bookingId:p.bookingId, folioId:"other-folio", amountPaise:p.amountPaise, currency:p.currency, providerId:p.providerId }; }
  }});
  await assert.rejects(f.orchestrator.createPayment(input), e => e.code === "INVALID_BACKEND_SESSION");
  assert.equal((await f.store.get("req-1")).state, "UNKNOWN");
});

test("backend reconciliation cannot change status without matching session and provider", async () => {
  const f = fixture({ backendOverrides: {
    async reconcile(p) { return { verified:true, status:"failed", requestId:p.requestId, sessionId:"wrong-session", providerId:p.providerId, bookingId:p.bookingId, amountPaise:p.amountPaise, currency:p.currency, folioId:p.folioId }; }
  }});
  await f.orchestrator.createPayment(input);
  const result = await f.orchestrator.reconcileOne("req-1");
  assert.equal(result.state, "PROCESSING");
});

test("a backend-verified failure can be reopened for late-capture verification", async () => {
  const f = fixture({ backendOverrides: {
    async reconcile(p) { return { verified:true, status:"failed", requestId:p.requestId, sessionId:p.sessionId, providerId:p.providerId, bookingId:p.bookingId, amountPaise:p.amountPaise, currency:p.currency, folioId:p.folioId }; }
  }});
  await f.orchestrator.createPayment(input);
  const failed = await f.orchestrator.reconcileOne("req-1");
  assert.equal(failed.state, "FAILED");
  f.backend.reconcile = async p => ({ verified:true, status:"success", requestId:p.requestId, sessionId:p.sessionId, providerId:p.providerId, bookingId:p.bookingId, amountPaise:p.amountPaise, currency:p.currency, folioId:p.folioId });
  const recovered = await f.orchestrator.reconcileOne("req-1");
  assert.equal(recovered.state, "SUCCESS");
  assert.equal(recovered.settlementAuthorized, true);
});

test("REQUESTED intent recovers a backend session after process death", async () => {
  const f = fixture();
  await f.store.put({
    requestId:"req-1", bookingId:"booking-1", folioId:"folio-1",
    amountPaise:12500, currency:"INR", providerId:"razorpay",
    state:"REQUESTED", backendSessionId:null, bridgeTransactionId:null,
    backendVerified:false, settlementAuthorized:false,
    createdAt:"2026-11-01T00:00:00.000Z", updatedAt:"2026-11-01T00:00:00.000Z",
    history:[{state:"CREATED"}]
  });
  f.backend.reconcile = async p => ({
    verified:true, status:"success", requestId:p.requestId, sessionId:"sess-recovered",
    providerId:p.providerId, bookingId:p.bookingId, folioId:p.folioId,
    amountPaise:p.amountPaise, currency:p.currency
  });
  const result = await f.orchestrator.reconcileOne("req-1");
  assert.equal(result.state, "SUCCESS");
  assert.equal(result.backendSessionId, "sess-recovered");
  assert.equal(result.settlementAuthorized, true);
});

test("malformed Bridge event status is rejected", async () => {
  const f = fixture();
  await f.orchestrator.createPayment(input);
  await assert.rejects(f.orchestrator.receiveBridgeEvent({
    requestId:"req-1", bookingId:"booking-1", folioId:"folio-1",
    amountPaise:12500, currency:"INR", status:"paid"
  }), e => e.code === "EVENT_BINDING_MISMATCH");
});

test("payment backend URL rejects embedded credentials and query strings", () => {
  assert.throws(() => createPaymentBackendClient({baseUrl:"https://user:pass@example.test",getAccessToken:async()=>"token"}));
  assert.throws(() => createPaymentBackendClient({baseUrl:"https://example.test?redirect=evil",getAccessToken:async()=>"token"}));
});

test("orchestrator rejects unsafe bridge timeouts", () => {
  const f = fixture();
  assert.throws(() => new PayBridgePaymentOrchestrator({
    store:f.store, bridge:f.bridge, backend:f.backend, requestTimeoutMs:0
  }), /requestTimeoutMs/);
});
