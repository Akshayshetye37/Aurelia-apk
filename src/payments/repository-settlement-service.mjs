/**
 * Async canonical folio settlement.
 *
 * The existing settlement service remains the policy/validation authority.
 * This adapter executes it against a repository-loaded folio snapshot and
 * commits the folio entity plus its immutable outbox event in one transaction.
 * It deliberately does not mirror the committed result into localStorage.
 */
import { settlePayment, moneyToPaise } from "./settlement-service.mjs";

const DUPLICATE_ABORT = "REPOSITORY_SETTLEMENT_DUPLICATE";
const clone = value => value == null ? value :
  (typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value)));

export async function settlePaymentToRepository({
  bridge,
  state,
  booking,
  balanceDueFor,
  amount,
  method,
  reference = "",
  source = "manual",
  idempotencyKey,
  verificationConfirmed = false,
  now = () => new Date().toISOString()
} = {}) {
  if (!bridge || typeof bridge.fetchEntity !== "function" ||
      typeof bridge.mutateFolioState !== "function") {
    throw new TypeError("A bound PMS repository bridge is required");
  }
  if (!state || !Array.isArray(state.b) || !booking || !state.b.includes(booking)) {
    throw new TypeError("Booking must belong to the supplied live PMS state");
  }
  if (typeof balanceDueFor !== "function") {
    throw new TypeError("A canonical folio balance calculator is required");
  }

  const entityId = String(booking.folioId || "booking-" + String(booking.id));
  const existing = await bridge.fetchEntity("folio", entityId);
  const expectedVersion = existing?.version ?? 0;
  const amountPaise = moneyToPaise(amount, "Payment amount");
  const eventPayload = {
    bookingId: entityId,
    amountPaise,
    method: String(method || "").trim(),
    reference: String(reference || "").trim(),
    source,
    idempotencyKey: String(idempotencyKey || "").trim() || null
  };

  let settlementResult = null;
  let nextToday = Number(state.today || 0);
  const auditRows = [];

  try {
    const committed = await bridge.mutateFolioState({
      entityId,
      expectedVersion,
      eventType: "folio.payment_posted",
      eventPayload,
      mutate: folio => {
        Object.assign(folio, clone(existing?.data ?? booking));
        const workingState = { b: [folio], today: nextToday, aud: [] };
        settlementResult = settlePayment({
          state: workingState,
          booking: folio,
          amount,
          method,
          reference,
          source,
          idempotencyKey,
          balanceDue: balanceDueFor(folio),
          verificationConfirmed,
          persist: () => {},
          audit: (action, detail) => auditRows.push({ a: action, d: detail, at: new Date(now()) }),
          now
        });
        if (settlementResult.duplicate) {
          const error = new Error("Payment was already committed to this folio");
          error.code = DUPLICATE_ABORT;
          throw error;
        }
        nextToday = workingState.today;
        if (auditRows.length) {
          folio.auditEvents = [...(Array.isArray(folio.auditEvents) ? folio.auditEvents : []), ...auditRows.map(clone)];
        }
        return settlementResult;
      }
    });

    Object.assign(booking, clone(committed.entity.data));
    state.today = nextToday;
    if (Array.isArray(state.aud)) {
      for (const row of auditRows.slice().reverse()) state.aud.unshift(clone(row));
    }
    return Object.freeze({
      ...committed.result,
      entity: committed.entity,
      eventSequence: committed.entity.version
    });
  } catch (error) {
    if (error?.code === DUPLICATE_ABORT && settlementResult) {
      if (existing?.data) Object.assign(booking, clone(existing.data));
      return Object.freeze({ ...settlementResult, entity: existing, eventSequence: existing?.version ?? 0 });
    }
    throw error;
  }
}
