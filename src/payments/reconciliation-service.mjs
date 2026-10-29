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
  if (!input || typeof input !== "object") throw new TypeError("Evidence input is required");
  const parseStatus = String(input.parseStatus || "parsed");
  const eventId = String(input.eventId || "").trim();
  const evidenceId = String(input.evidenceId || eventId).trim();
  const source = String(input.source || "").trim();
  if (!eventId || !evidenceId || !source) throw new TypeError("eventId, evidenceId, and source are required");

  if (parseStatus === "unparsed") {
    return {
      ...input, eventId, evidenceId, source, parseStatus,
      amountPaise: input.amountPaise == null ? null : input.amountPaise,
      currency: String(input.currency || "INR").toUpperCase(),
      rawEvidence: input.rawEvidence == null ? null : String(input.rawEvidence),
      receivedAt: input.receivedAt || new Date().toISOString()
    };
  }

  const amountPaise = Number.isInteger(input.amountPaise)
    ? input.amountPaise
    : parseAmountToPaise(input.amount ?? input.amountText);
  const event = createPaymentEvent({ ...input, eventId, evidenceId, source, amountPaise });
  return { ...event, ...input, eventId, evidenceId, source, parseStatus, amountPaise };
}

function isCandidate(event) {
  return candidateSources.has(String(event.source || "")) || candidateTypes.has(String(event.eventType || ""));
}
function isBankCredit(event) {
  return event.parseStatus !== "unparsed" && event.eventType === "credit" &&
    (String(event.source || "").includes("bank") || Boolean(event.bank));
}

export function createReconciliationService({ store, matchOptions = {} } = {}) {
  if (!store || typeof store.addEvidence !== "function" || typeof store.listEvidence !== "function") {
    throw new TypeError("A compatible persistent evidence store is required");
  }

  async function reconcile() {
    const evidence = await store.listEvidence({ limit: 10000 });
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
      if (decision?.decision === "posted" || decision?.decision === "settled") {
        throw new Error("Staff review cannot post or settle a folio through the reconciliation service");
      }
      return store.recordDecision(decision);
    }
  };
}
