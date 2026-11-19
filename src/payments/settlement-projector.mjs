import { settlePayment } from "./settlement-service.mjs";
import { AUTO_FOLIO_SETTLEMENT_ENABLED } from "./settlement-gate.mjs";
import { IndexedDbSettlementJournal } from "./settlement-journal.mjs";

const PERMANENT_FAILURES = new Set([
  "BOOKING_NOT_FOUND", "BOOKING_NOT_SETTLEABLE", "IDEMPOTENCY_KEY_CONFLICT",
  "PAYMENT_REFERENCE_ALREADY_APPLIED", "PAYMENT_REFERENCE_CONFLICT",
  "PAYMENT_EXCEEDS_BALANCE", "AUTHORIZATION_BINDING_MISMATCH",
  "SETTLEMENT_AUTH_INVALID", "SETTLEMENT_AUTH_SIGNATURE_INVALID", "SETTLEMENT_AUTH_KEY_INVALID", "SETTLEMENT_AUTH_UNKNOWN_KEY",
  "SETTLEMENT_AUTH_MISMATCH", "SETTLEMENT_LEASE_MISMATCH"
]);
function fail(code, message) { const error = new Error(message); error.code = code; return error; }
function paise(row) { return Number.isSafeInteger(row?.amountPaise) ? row.amountPaise : Math.round(Number(row?.a ?? row?.amount) * 100); }

export class SettlementProjector {
  constructor({ journal, verifier, getLease, getState, findBooking, getBalanceDue, persist, readBack,
    flush = async () => {}, isEmergencyStopped, audit = () => {},
    autoSettlementEnabled = AUTO_FOLIO_SETTLEMENT_ENABLED, settle = settlePayment,
    now = () => new Date().toISOString(), locks = globalThis.navigator?.locks } = {}) {
    const required = { getLease, getState, findBooking, getBalanceDue, persist, readBack, isEmergencyStopped };
    for (const [name, fn] of Object.entries(required)) if (typeof fn !== "function") throw fail("SETTLEMENT_PROJECTOR_UNAVAILABLE", name + " is required");
    if (!journal || !verifier) throw fail("SETTLEMENT_PROJECTOR_UNAVAILABLE", "journal and verifier are required");
    if (persist.synchronous !== true || persist.constructor?.name === "AsyncFunction") throw fail("SETTLEMENT_PROJECTOR_UNAVAILABLE", "persist must be explicitly marked as a synchronous durable adapter");
    Object.assign(this, { journal, verifier, getLease, getState, findBooking, getBalanceDue, persist, readBack, flush,
      isEmergencyStopped, audit, autoSettlementEnabled, settle, now, locks });
    this.tail = Promise.resolve();
  }
  run(fn) {
    const exec = () => this.locks?.request ? this.locks.request("aurelia-settlement-projector", fn) : fn();
    const next = this.tail.then(exec, exec); this.tail = next.catch(() => {}); return next;
  }
  async submit({ command, authorization, lease }) {
    const policyLease = lease || await this.getLease();
    await this.verifier.verify({ authorization, lease: policyLease, command });
    const { record } = await this.journal.append({
      tenantId: command.tenantId, deviceId: command.deviceId, provider: command.provider,
      providerAccountId: command.providerAccountId, environment: command.environment,
      providerTransactionId: command.providerTransactionId, commandId: command.commandId,
      payload: { command }, authorization, policyLease
    });
    return this.project(record.key);
  }
  async recoverPending() {
    const results = [];
    for (const record of await this.journal.listPending()) results.push(await this.project(record.key));
    return results;
  }
  project(key) { return this.run(() => this.projectLocked(key)); }
  async projectLocked(key) {
    const record = await this.journal.get(key);
    if (!record) throw fail("SETTLEMENT_RECORD_NOT_FOUND", "Settlement journal record not found");
    if (record.status === "APPLIED") return { status: "applied", duplicate: true, key };
    if (record.status === "REJECTED") return { status: "rejected", code: record.rejectedReason, key };
    const command = record.payload.command;
    const authorization = record.authorization;
    const policyLease = record.policyLease;
    try {
      const binding = await this.verifier.verify({ authorization, lease: policyLease, command });
      const state = this.getState(); const booking = this.findBooking(state, command.bookingId);
      if (!booking) throw fail("BOOKING_NOT_FOUND", "Booking not found");
      const result = this.settle({
        state, booking, amount: command.amountPaise / 100, method: command.method, reference: command.reference,
        source: "verified_gateway", idempotencyKey: binding.idempotencyKey,
        balanceDue: this.getBalanceDue(booking, state), authorization: binding,
        autoSettlementEnabled: this.autoSettlementEnabled, isEmergencyStopped: this.isEmergencyStopped,
        tenantId: binding.tenantId, deviceId: binding.deviceId,
        providerAccountId: binding.providerAccountId, environment: binding.environment,
        persist: this.persist, audit: this.audit, now: this.now
      });
      await this.flush();
      await this.confirmPersisted(binding);
      await this.journal.markApplied(record.key, record.payloadHash);
      return { status: "applied", duplicate: result.duplicate, key, payment: result.payment };
    } catch (error) {
      const code = error?.code || "SETTLEMENT_PROJECTION_FAILED";
      if (PERMANENT_FAILURES.has(code)) {
        await this.journal.markRejected(record.key, record.payloadHash, code);
        return { status: "rejected", code, message: error.message, key };
      }
      return { status: "pending", code, message: error?.message, key };
    }
  }
  async confirmPersisted(binding) {
    const state = await this.readBack(); const booking = this.findBooking(state, binding.bookingId);
    const allBookings = [...(Array.isArray(state?.b) ? state.b : []), ...(Array.isArray(state?.cancelled) ? state.cancelled : [])];
    const globalMatches = allBookings.flatMap(item => (Array.isArray(item?.pays) ? item.pays : [])
      .filter(row => row?.idempotencyKey === binding.idempotencyKey).map(row => ({ booking: item, row })));
    const rows = globalMatches.filter(match => match.booking === booking).map(match => match.row);
    const row = rows[0];
    const storedReference = row?.r ?? row?.reference;
    const normalizedReference = value => /upi|bank|neft|rtgs|imps|card|wallet/i.test(binding.method)
      ? String(value ?? "").replace(/\s+/g, "").toUpperCase() : String(value ?? "");
    if (globalMatches.length !== 1 || rows.length !== 1 || !row || row.bookingId !== binding.bookingId ||
        row.source !== "verified_gateway" || paise(row) !== binding.amountPaise ||
        String(row.m ?? row.method).toLowerCase() !== binding.method.toLowerCase() ||
        !storedReference || normalizedReference(storedReference) !== normalizedReference(binding.reference) ||
        row.authorizationId !== binding.authorizationId || row.leaseId !== binding.leaseId ||
        row.provider !== binding.provider || row.providerTransactionId !== binding.providerTransactionId ||
        row.tenantId !== binding.tenantId || row.deviceId !== binding.deviceId ||
        row.providerAccountId !== binding.providerAccountId || row.environment !== binding.environment) {
      throw fail("PAYMENT_READBACK_MISMATCH", "Persisted payment does not match the verified settlement identity");
    }
    return row;
  }
}
export { IndexedDbSettlementJournal };
