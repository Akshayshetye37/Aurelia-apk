/**
 * PMS payment orchestration boundary.
 *
 * This module coordinates the native Pay Bridge and trusted payment backend.
 * It is deliberately NOT a payment processor or accounting ledger. A bridge
 * callback can never authorize folio settlement; only a backend verification
 * response with a matching immutable transaction binding can do that.
 */
export const PAYMENT_STATES = Object.freeze({
  CREATED: "CREATED", REQUESTED: "REQUESTED", PROCESSING: "PROCESSING",
  SUCCESS: "SUCCESS", FAILED: "FAILED", CANCELLED: "CANCELLED",
  UNKNOWN: "UNKNOWN", RECONCILIATION: "RECONCILIATION"
});

const TERMINAL = new Set(["FAILED", "CANCELLED"]);
const ALLOWED = Object.freeze({
  CREATED: new Set(["REQUESTED", "CANCELLED"]),
  REQUESTED: new Set(["PROCESSING", "UNKNOWN", "FAILED", "CANCELLED", "RECONCILIATION"]),
  PROCESSING: new Set(["SUCCESS", "FAILED", "CANCELLED", "UNKNOWN"]),
  SUCCESS: new Set(),
  // Reopen only through a fresh backend reconciliation: provider capture can arrive late.
  FAILED: new Set(["RECONCILIATION"]),
  CANCELLED: new Set(["RECONCILIATION"]),
  UNKNOWN: new Set(["RECONCILIATION", "PROCESSING", "FAILED", "CANCELLED"]),
  RECONCILIATION: new Set(["SUCCESS", "PROCESSING", "FAILED", "CANCELLED", "UNKNOWN"])
});

const id = () => globalThis.crypto?.randomUUID?.() ??
  "pay-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
const text = (v, name, max = 128) => {
  const s = String(v ?? "").trim();
  if (!s || s.length > max || /[\u0000-\u001f\u007f]/.test(s)) {
    throw new TypeError(name + " is required, must be bounded, and cannot contain control characters");
  }
  return s;
};
const amount = v => {
  if (!Number.isSafeInteger(v) || v <= 0) throw new TypeError("amountPaise must be a positive safe integer");
  return v;
};
const clone = value => JSON.parse(JSON.stringify(value));

export class PaymentOrchestratorError extends Error {
  constructor(code, message) { super(message); this.name = "PaymentOrchestratorError"; this.code = code; }
}

export function transitionPayment(record, nextState, patch = {}, now = () => new Date().toISOString()) {
  if (!record || !Object.hasOwn(PAYMENT_STATES, record.state)) throw new TypeError("Invalid payment record");
  if (!Object.hasOwn(PAYMENT_STATES, nextState) || !ALLOWED[record.state].has(nextState)) {
    throw new PaymentOrchestratorError("INVALID_TRANSITION", record.state + " -> " + nextState + " is not allowed");
  }
  return { ...record, ...patch, state: nextState, updatedAt: now(), history: [...(record.history || []).slice(-99), { state: nextState, at: now() }] };
}

/**
 * Required dependencies:
 * - store: durable adapter with async put(record), get(requestId), listPending()
 * - bridge: authenticated native IPC adapter; createPayment/status/cancel/refund
 * - backend: trusted HTTPS API adapter; createSession/verify/status/reconcile/refund
 * No default in-memory persistence is supplied: callers must provide durable
 * storage so process death cannot silently erase in-flight payment state.
 */
export class PayBridgePaymentOrchestrator {
  constructor({ store, bridge, backend, now = () => new Date().toISOString(), requestTimeoutMs = 45000 } = {}) {
    if (!store || !["put", "get", "listPending"].every(k => typeof store[k] === "function")) {
      throw new TypeError("A durable payment store implementing put/get/listPending is required");
    }
    if (!bridge || !["isAuthenticated", "createPayment", "getPaymentStatus", "cancelPayment"].every(k => typeof bridge[k] === "function")) {
      throw new TypeError("A Pay Bridge adapter is required");
    }
    if (!backend || !["createSession", "verifyPayment", "getPaymentStatus", "reconcile"].every(k => typeof backend[k] === "function")) {
      throw new TypeError("A trusted payment backend adapter is required");
    }
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1000 || requestTimeoutMs > 120000) {
      throw new TypeError("requestTimeoutMs must be an integer between 1000 and 120000");
    }
    this.store = store; this.bridge = bridge; this.backend = backend;
    this.now = now; this.requestTimeoutMs = requestTimeoutMs;
  }

  async createPayment(input) {
    const requestId = text(input?.requestId || id(), "requestId");
    const record = {
      requestId, bookingId: text(input?.bookingId, "bookingId"),
      folioId: text(input?.folioId, "folioId"),
      amountPaise: amount(input?.amountPaise),
      currency: text(input?.currency || "INR", "currency", 3).toUpperCase(),
      providerId: text(input?.providerId, "providerId", 64),
      state: PAYMENT_STATES.CREATED, backendSessionId: null, bridgeTransactionId: null,
      backendVerified: false, settlementAuthorized: false,
      bridgeDispatchStarted: false,
      createdAt: this.now(), updatedAt: this.now(), history: [{ state: "CREATED", at: this.now() }]
    };
    if (record.currency !== "INR") throw new PaymentOrchestratorError("CURRENCY_UNSUPPORTED", "Only INR is enabled in this PMS integration");
    const existing = await this.store.get(requestId);
    let current;
    if (existing) {
      if (existing.bookingId !== record.bookingId || existing.folioId !== record.folioId ||
          existing.amountPaise !== record.amountPaise || existing.providerId !== record.providerId) {
        throw new PaymentOrchestratorError("IDEMPOTENCY_CONFLICT", "Request ID was already used with different payment details");
      }
      if (existing.state === "REQUESTED") {
        return existing.bridgeDispatchStarted === false
          ? this.resumeUndispatched(existing)
          : this.reconcileOne(requestId);
      }
      if (existing.state !== "CREATED") return clone(existing);
      current = existing;
    } else {
      await this.store.put(record);
      current = record;
    }
    if (!this.bridge.isAuthenticated()) throw new PaymentOrchestratorError("BRIDGE_DISCONNECTED", "Gateway checkout is unavailable; payment request remains safely recorded");
    current = transitionPayment(current, "REQUESTED", {}, this.now);
    await this.store.put(current);
    try {
      current = await this.ensureBackendSession(current);
      return await this.dispatchRequested(current);
    } catch (error) {
      // Once REQUESTED has been persisted, a thrown error cannot prove that
      // the backend or Bridge did not act. Preserve the request as UNKNOWN;
      // reconciliation must resolve it before any retry can create checkout.
      const latest = await this.store.get(requestId);
      if (latest && ["REQUESTED", "PROCESSING"].includes(latest.state) &&
          ALLOWED[latest.state].has("UNKNOWN")) {
        await this.store.put(transitionPayment(latest, "UNKNOWN", {
          lastErrorCode: String(error?.code || error?.name || "REQUEST_OUTCOME_UNKNOWN").slice(0, 64)
        }, this.now));
      }
      throw error;
    }
  }

  async ensureBackendSession(record) {
    if (record.backendSessionId) return record;
    const session = await this.backend.createSession({
      requestId: record.requestId, bookingId: record.bookingId, folioId: record.folioId,
      amountPaise: record.amountPaise, currency: record.currency, providerId: record.providerId,
      idempotencyKey: record.requestId
    });
    if (!session || session.requestId !== record.requestId ||
        session.bookingId !== record.bookingId || session.folioId !== record.folioId ||
        session.amountPaise !== record.amountPaise || session.currency !== record.currency ||
        session.providerId !== record.providerId || typeof session.sessionId !== "string" ||
        !session.sessionId || session.sessionId.length > 256) {
      throw new PaymentOrchestratorError("INVALID_BACKEND_SESSION", "Backend returned an invalid payment session binding");
    }
    const updated = { ...record, backendSessionId: text(session.sessionId, "sessionId"), updatedAt: this.now() };
    await this.store.put(updated);
    return updated;
  }

  /**
   * Persist a dispatch marker before calling the native service. On restart,
   * REQUESTED+marker=false is safe to resume; REQUESTED+marker=true is
   * ambiguous and must be reconciled, never blindly dispatched again.
   */
  async dispatchRequested(record) {
    if (record.state !== "REQUESTED") {
      throw new PaymentOrchestratorError("INVALID_TRANSITION", "Only a REQUESTED intent can be dispatched");
    }
    if (!record.backendSessionId) {
      throw new PaymentOrchestratorError("BACKEND_SESSION_MISSING", "A backend session is required before native dispatch");
    }
    if (!this.bridge.isAuthenticated()) return clone(record);
    const marked = {
      ...record, bridgeDispatchStarted: true, updatedAt: this.now(),
      history: [...(record.history || []).slice(-99), { state: "REQUESTED", event: "BRIDGE_DISPATCH_STARTED", at: this.now() }]
    };
    await this.store.put(marked);
    const result = await this.bridge.createPayment({
      requestId: record.requestId, sessionId: record.backendSessionId,
      amountPaise: record.amountPaise, currency: record.currency,
      providerId: record.providerId, bookingId: record.bookingId, folioId: record.folioId
    }, { timeoutMs: this.requestTimeoutMs });
    if (!result || result.requestId !== record.requestId) {
      throw new PaymentOrchestratorError("INVALID_BRIDGE_RESPONSE", "Pay Bridge response did not match the request");
    }
    const hasSafeTransactionId = typeof result.transactionId === "string" &&
      result.transactionId.length > 0 && result.transactionId.length <= 256 &&
      !/[\u0000-\u001f\u007f]/.test(result.transactionId);
    const nextState = result.status === "processing" && hasSafeTransactionId ? "PROCESSING" : "UNKNOWN";
    const updated = transitionPayment(marked, nextState, {
      bridgeTransactionId: hasSafeTransactionId ? result.transactionId : marked.bridgeTransactionId
    }, this.now);
    await this.store.put(updated);
    if (nextState === "UNKNOWN") return this.reconcileOne(record.requestId);
    return clone(updated);
  }

  async resumeUndispatched(record) {
    if (!this.bridge.isAuthenticated()) return clone(record);
    const withSession = await this.ensureBackendSession(record);
    return this.dispatchRequested(withSession);
  }

  async receiveBridgeEvent(event) {
    const requestId = text(event?.requestId, "requestId");
    const record = await this.store.get(requestId);
    if (!record) throw new PaymentOrchestratorError("UNKNOWN_REQUEST", "No PMS payment matches this event");
    if (!["processing", "success", "failed", "cancelled", "unknown"].includes(event.status) ||
        event.amountPaise !== record.amountPaise || event.currency !== record.currency ||
        event.folioId !== record.folioId || event.bookingId !== record.bookingId) {
      throw new PaymentOrchestratorError("EVENT_BINDING_MISMATCH", "Bridge event does not match the original payment");
    }
    if (record.state === "SUCCESS") return clone(record);
    // Bridge events are hints only. A failure, cancellation or success event
    // triggers backend reconciliation; it never directly finalizes a payment.
    const next = event.status === "processing" ? "PROCESSING" : "UNKNOWN";
    if (["FAILED", "CANCELLED"].includes(record.state)) {
      const reopened = transitionPayment(record, "RECONCILIATION", {}, this.now);
      await this.store.put(reopened);
      return this.reconcileOne(requestId);
    }
    if (!ALLOWED[record.state].has(next)) return clone(record);
    const updated = transitionPayment(record, next, { bridgeTransactionId: event.transactionId || record.bridgeTransactionId }, this.now);
    await this.store.put(updated);
    if (next === "UNKNOWN") return this.reconcileOne(requestId);
    // A bridge "success" is intentionally mapped to UNKNOWN pending backend proof.
    return clone(updated);
  }

  async verifyPayment(requestId) {
    let record = await this.requireRecord(requestId);
    if (record.state === "REQUESTED") {
      // Missing marker means an older app version may have dispatched before
      // persisting the marker. Treat that legacy state as ambiguous.
      if (record.bridgeDispatchStarted === false) return this.resumeUndispatched(record);
      record = transitionPayment(record, "UNKNOWN", { lastErrorCode: "DISPATCH_OUTCOME_UNKNOWN" }, this.now);
      await this.store.put(record);
    }
    if (["UNKNOWN", "FAILED", "CANCELLED"].includes(record.state)) {
      record = transitionPayment(record, "RECONCILIATION", {}, this.now);
      await this.store.put(record);
    }
    const result = await this.backend.verifyPayment({
      requestId: record.requestId, sessionId: record.backendSessionId,
      transactionId: record.bridgeTransactionId, amountPaise: record.amountPaise,
      currency: record.currency, folioId: record.folioId, bookingId: record.bookingId
    });
    const validSession = typeof result?.sessionId === "string" &&
      result.sessionId.length > 0 && result.sessionId.length <= 256 &&
      (!record.backendSessionId || result.sessionId === record.backendSessionId);
    if (!result || result.verified !== true || result.status !== "success" || !validSession ||
        result.requestId !== record.requestId ||
        result.providerId !== record.providerId || result.amountPaise !== record.amountPaise ||
        result.currency !== record.currency || result.folioId !== record.folioId ||
        result.bookingId !== record.bookingId ||
        typeof result.transactionId !== "string" || !result.transactionId || result.transactionId.length > 256 ||
        /[\u0000-\u001f\u007f]/.test(result.transactionId) ||
        (record.bridgeTransactionId && result.transactionId !== record.bridgeTransactionId)) {
      throw new PaymentOrchestratorError("BACKEND_NOT_VERIFIED", "Backend did not independently verify this exact payment");
    }
    if (record.state === "SUCCESS") return clone(record);
    if (!ALLOWED[record.state].has("SUCCESS")) {
      if (["REQUESTED", "UNKNOWN", "FAILED", "CANCELLED"].includes(record.state)) {
        const recon = transitionPayment(record, "RECONCILIATION", {}, this.now);
        await this.store.put(recon);
        return this.verifyPayment(requestId);
      }
      throw new PaymentOrchestratorError("INVALID_TRANSITION", "Payment cannot be verified from state " + record.state);
    }
    const verified = transitionPayment(record, "SUCCESS", {
      backendSessionId: record.backendSessionId || result.sessionId,
      bridgeTransactionId: result.transactionId, backendVerified: true,
      settlementAuthorized: true, backendVerifiedAt: this.now()
    }, this.now);
    await this.store.put(verified);
    return clone(verified);
  }

  async reconcileOne(requestId) {
    let record = await this.requireRecord(requestId);
    // CREATED has not been dispatched; leave it for an explicit retry after
    // Bridge reconnects rather than querying the backend for a missing session.
    if (record.state === "CREATED" ||
        (record.state === "CANCELLED" && !record.backendSessionId)) return clone(record);
    if (record.state === "REQUESTED") {
      // Only a durable false marker proves native dispatch has not started.
      // Missing/true markers are treated as ambiguous and never replayed.
      if (record.bridgeDispatchStarted === false) return this.resumeUndispatched(record);
      record = transitionPayment(record, "UNKNOWN", { lastErrorCode: "DISPATCH_OUTCOME_UNKNOWN" }, this.now);
      await this.store.put(record);
    }
    if (["UNKNOWN", "FAILED", "CANCELLED"].includes(record.state)) {
      record = transitionPayment(record, "RECONCILIATION", {}, this.now);
      await this.store.put(record);
    }
    const result = await this.backend.reconcile({
      requestId: record.requestId, sessionId: record.backendSessionId,
      transactionId: record.bridgeTransactionId, amountPaise: record.amountPaise,
      currency: record.currency, folioId: record.folioId, bookingId: record.bookingId
    });
    // A reconciliation response is authoritative only when the backend
    // verifies and echoes every immutable PMS binding.
    const validSession = typeof result?.sessionId === "string" &&
      result.sessionId.length > 0 && result.sessionId.length <= 256 &&
      (!record.backendSessionId || result.sessionId === record.backendSessionId);
    const bound = result?.verified === true && validSession &&
      result.requestId === record.requestId &&
      result.bookingId === record.bookingId &&
      result.providerId === record.providerId &&
      result.folioId === record.folioId &&
      result.amountPaise === record.amountPaise &&
      result.currency === record.currency;
    if (!bound) return clone(record);
    if (!record.backendSessionId) {
      record = { ...record, backendSessionId: result.sessionId, updatedAt: this.now() };
      await this.store.put(record);
    }
    if (result.status === "success") return this.verifyPayment(requestId);
    if (result.status === "failed" && ALLOWED[record.state].has("FAILED")) {
      const failed = transitionPayment(record, "FAILED", { backendVerified: true }, this.now);
      await this.store.put(failed); return clone(failed);
    }
    if (result.status === "cancelled" && ALLOWED[record.state].has("CANCELLED")) {
      const cancelled = transitionPayment(record, "CANCELLED", { backendVerified: true }, this.now);
      await this.store.put(cancelled); return clone(cancelled);
    }
    if (result.status === "processing" && ALLOWED[record.state].has("PROCESSING")) {
      const pending = transitionPayment(record, "PROCESSING", { backendVerified: true }, this.now);
      await this.store.put(pending); return clone(pending);
    }
    return clone(record);
  }

  async reconcilePending() {
    const records = await this.store.listPending();
    const results = [];
    for (const item of records) {
      if (!item || !item.requestId || item.state === "SUCCESS" || item.state === "CREATED" ||
          (item.state === "CANCELLED" && !item.backendSessionId)) continue;
      try { results.push(await this.reconcileOne(item.requestId)); }
      catch (error) { results.push({ requestId: item.requestId, state: item.state, error: error.code || "RECONCILIATION_FAILED" }); }
    }
    return results;
  }

  async cancelPayment(requestId) {
    const record = await this.requireRecord(requestId);
    if (record.state === "SUCCESS") return clone(record);
    if (record.state === "CREATED" ||
        (record.state === "REQUESTED" && record.bridgeDispatchStarted === false)) {
      const cancelled = transitionPayment(record, "CANCELLED", {}, this.now);
      await this.store.put(cancelled);
      return clone(cancelled);
    }
    if (!this.bridge.isAuthenticated()) throw new PaymentOrchestratorError("BRIDGE_DISCONNECTED", "Pay Bridge is unavailable");
    try {
      const result = await this.bridge.cancelPayment({ requestId, sessionId: record.backendSessionId });
      if (result?.requestId !== requestId || result?.status !== "cancelled") {
        throw new PaymentOrchestratorError("CANCEL_UNCONFIRMED", "Bridge cancellation was not acknowledged");
      }
    } catch {
      // A lost response does not prove that the provider stopped. Reconcile.
    }
    const latest = await this.requireRecord(requestId);
    if (ALLOWED[latest.state].has("UNKNOWN")) {
      await this.store.put(transitionPayment(latest, "UNKNOWN", {}, this.now));
    }
    const reconciled = await this.reconcileOne(requestId);
    if (reconciled.state === "CANCELLED") return clone(reconciled);
    throw new PaymentOrchestratorError("CANCEL_UNCONFIRMED", "Backend has not independently confirmed cancellation; payment remains " + reconciled.state);
  }

  async requireRecord(requestId) {
    const record = await this.store.get(text(requestId, "requestId"));
    if (!record) throw new PaymentOrchestratorError("UNKNOWN_REQUEST", "Payment request not found");
    return record;
  }

  /** Refund is backend-authorized; never sent directly to a provider from PMS. */
  async createRefund({ requestId }) {
    const record = await this.requireRecord(requestId);
    if (record.state !== "SUCCESS" || !record.backendVerified || !record.settlementAuthorized) {
      throw new PaymentOrchestratorError("REFUND_NOT_ELIGIBLE", "Only backend-verified and settlement-authorized payments may be refunded");
    }
    // Refunds require their own durable idempotent journal, cumulative amount
    // accounting, backend verification and PMS ledger reversal. None of those
    // contracts is active in this local-first release, so never send a refund.
    throw new PaymentOrchestratorError("REFUND_UNAVAILABLE", "Refunds are disabled until the durable refund lifecycle is implemented");
  }
}

/** Minimal HTTPS-only JSON transport adapter; authentication is supplied by a token provider. */
export function createPaymentBackendClient({ baseUrl, getAccessToken, fetchImpl = globalThis.fetch } = {}) {
  const base = text(baseUrl, "baseUrl");
  let parsedBase;
  try { parsedBase = new URL(base); } catch { throw new TypeError("Invalid payment backend URL"); }
  if (parsedBase.protocol !== "https:" || parsedBase.username || parsedBase.password ||
      parsedBase.search || parsedBase.hash || !fetchImpl || typeof getAccessToken !== "function") {
    throw new TypeError("A clean HTTPS backend URL, fetch implementation and access-token provider are required");
  }
  const call = async (path, body) => {
    const token = text(await getAccessToken(), "access token", 4096);
    const response = await fetchImpl(new URL(path, parsedBase), {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify(body), cache: "no-store", credentials: "omit",
      redirect: "error", signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new PaymentOrchestratorError("BACKEND_HTTP_" + response.status, "Payment backend request failed");
    return response.json();
  };
  return Object.freeze({
    createSession: body => call("/v1/payment-sessions", body),
    verifyPayment: body => call("/v1/payments/verify", body),
    getPaymentStatus: body => call("/v1/payments/status", body),
    reconcile: body => call("/v1/payments/reconcile", body),
    createRefund: body => call("/v1/refunds", body)
  });
}
