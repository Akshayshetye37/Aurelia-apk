/**
 * Reconciliation coordinator for normalized evidence.
 *
 * It re-evaluates all available evidence after every ingest, so GPay and bank
 * records may arrive in either order. It never posts a folio.
 */
import { createPaymentEvent, matchBankEvent, parseAmountToPaise } from "./payment-engine.mjs";

const candidateSources = new Set(["gpay_notification", "guest_utr", "statement_import"]);
const candidateTypes = new Set(["payment_notification", "payment_candidate", "guest_utr"]);

function normalizeInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Evidence input is required");
  const parseStatus = String(input.parseStatus || "parsed").trim().toLowerCase();
  if (!["parsed", "unparsed"].includes(parseStatus)) throw new TypeError("parseStatus must be parsed or unparsed");
  const eventId = String(input.eventId || "").trim();
  const evidenceId = String(input.evidenceId || eventId).trim();
  const source = String(input.source || "").trim().toLowerCase();
  const safe = value => !/[\u0000-\u001f\u007f]/.test(value);
  if (!eventId || eventId.length > 128 || !safe(eventId) ||
      !evidenceId || evidenceId.length > 128 || !safe(evidenceId) ||
      !source || source.length > 64 || !safe(source)) {
    throw new TypeError("eventId, evidenceId, and source must be bounded safe strings");
  }

  const suppliedCurrency = input.currency == null || String(input.currency).trim() === ""
    ? null : String(input.currency).trim().toUpperCase();
  if (suppliedCurrency && !/^[A-Z]{3}$/.test(suppliedCurrency)) throw new TypeError("Invalid evidence currency");
  const currency = suppliedCurrency || (parseStatus === "parsed" ? "INR" : null);
  const unsupportedCurrency = Boolean(currency && currency !== "INR");
  const receivedAt = input.receivedAt ? new Date(input.receivedAt) : new Date();
  if (Number.isNaN(receivedAt.getTime())) throw new TypeError("Invalid receivedAt timestamp");
  const rawEvidence = input.rawEvidence == null ? null : String(input.rawEvidence);
  if (rawEvidence && rawEvidence.length > 8192) throw new TypeError("rawEvidence exceeds 8192 characters");

  if (parseStatus === "unparsed" || unsupportedCurrency) {
    return {
      ...input, eventId, evidenceId, source, parseStatus: "unparsed",
      amountPaise: input.amountPaise == null ? null : input.amountPaise,
      currency, rawEvidence, receivedAt: receivedAt.toISOString(),
      reviewReason: unsupportedCurrency ? "unsupported_currency" : (input.reviewReason || "unparsed_evidence")
    };
  }

  const amountPaise = Number.isSafeInteger(input.amountPaise)
    ? input.amountPaise
    : parseAmountToPaise(input.amount ?? input.amountText);
  const event = createPaymentEvent({
    ...input, eventId, evidenceId, source, currency, amountPaise,
    receivedAt: receivedAt.toISOString(), rawEvidence
  });
  return {
    ...input, ...event, eventId, evidenceId, source, parseStatus: "parsed",
    currency, amountPaise, receivedAt: receivedAt.toISOString(), rawEvidence
  };
}
function isCandidate(event) {
  return event.parseStatus !== "unparsed" && event.currency === "INR" &&
    !isBankCredit(event) &&
    (candidateSources.has(String(event.source || "").toLowerCase()) ||
      candidateTypes.has(String(event.eventType || "").toLowerCase()));
}
function isBankCredit(event) {
  return event.parseStatus !== "unparsed" && event.currency === "INR" &&
    String(event.eventType || "").toLowerCase() === "credit" &&
    (String(event.source || "").toLowerCase().includes("bank") || Boolean(event.bank));
}

export function createReconciliationService({ store, matchOptions = {} } = {}) {
  if (!store || typeof store.addEvidence !== "function" || typeof store.listEvidence !== "function") {
    throw new TypeError("A compatible persistent evidence store is required");
  }

  async function reconcile() {
    const evidence = await store.listEvidence({ limit: 1000 });
    const candidates = evidence.filter(isCandidate);
    const bankEvents = evidence.filter(isBankCredit);
    const results = bankEvents.map(bankEvent => {
      const result = matchBankEvent(bankEvent, candidates, matchOptions);
      return {
        bankEvidenceId: bankEvent.evidenceId,
        decision: result.decision,
        reason: result.reason,
        matches: (result.matches || []).map(item => ({
          candidateEvidenceId: item.candidate?.evidenceId || item.candidate?.eventId || null,
          candidateEventId: item.candidate?.eventId || null,
          score: item.score,
          reasons: item.reasons
        }))
      };
    });

    const unparsed = evidence.filter(event => event.parseStatus === "unparsed").map(event => ({
      evidenceId: event.evidenceId, decision: "review", reason: "unparsed_evidence"
    }));
    return { results, unparsedEvidence: unparsed, evidenceCount: evidence.length, settlementEnabled: false };
  }

  return {
    async ingest(input) {
      const normalized = normalizeInput(input);
      const stored = await store.addEvidence(normalized);
      return { stored, reconciliation: await reconcile() };
    },
    reconcile,
    async listEvidence(options) {
      return store.listEvidence(options);
    },
    async recordStaffDecision(decision) {
      const allowed = new Set(["needs_review", "reviewed", "rejected", "not_a_match", "duplicate"]);
      if (!decision || !allowed.has(String(decision.decision || ""))) {
        throw new Error("Staff review accepts review-only decisions; folio posting and payment confirmation are disabled");
      }
      if (typeof store.getEvidence === "function" && !(await store.getEvidence(decision.evidenceId))) {
        throw new Error("Evidence record was not found for this staff decision");
      }
      return store.recordDecision(decision);
    }
  };
}
