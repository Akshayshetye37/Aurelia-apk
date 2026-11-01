/**
 * Direct-UPI reconciliation primitives for Aurelia PMS.
 *
 * This module deliberately does not post to a folio. It normalizes evidence,
 * scores candidate matches, and queues uncertain matches for staff review.
 * A notification/SMS is evidence, not cryptographic proof of a bank credit.
 */

export const DEFAULT_MATCH_WINDOW_MS = 5 * 60 * 1000;

const CANDIDATE_SOURCES = new Set(["gpay_notification", "guest_utr", "statement_import"]);
const CANDIDATE_TYPES = new Set(["payment_notification", "payment_candidate", "guest_utr"]);

function boundedText(value, label, max, required = false) {
  const result = String(value ?? "").trim();
  if ((required && !result) || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new TypeError("Invalid " + label);
  }
  return result || null;
}


export function normalizeName(value = "") {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeUpiId(value = "") {
  return String(value).trim().toLowerCase();
}

export function parseAmountToPaise(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) throw new TypeError("Amount must be positive and finite");
    const paise = Math.round(value * 100);
    if (Math.abs(value * 100 - paise) > 1e-7) throw new TypeError("Amount has more than two decimal places");
    return paise;
  }
  const cleaned = String(value ?? "").replace(/[,₹\s]/g, "").replace(/^(INR|RS\.?)/i, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) throw new TypeError("Invalid INR amount");
  const paise = Math.round(Number(cleaned) * 100);
  if (!Number.isSafeInteger(paise) || paise <= 0) throw new TypeError("Amount must be a positive INR value");
  return paise;
}

export function createPaymentEvent(input) {
  if (!input || typeof input !== "object") throw new TypeError("Payment event input is required");
  const amountPaise = Number.isInteger(input.amountPaise)
    ? input.amountPaise
    : parseAmountToPaise(input.amount ?? input.amountText);
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    throw new TypeError("amountPaise must be a positive integer");
  }

  const eventId = boundedText(input.eventId || cryptoSafeId(), "eventId", 128, true);
  const evidenceId = boundedText(input.evidenceId || eventId, "evidenceId", 128, true);
  const source = boundedText(input.source || "unknown", "source", 64, true).toLowerCase();
  const eventType = boundedText(input.eventType || "unknown", "eventType", 64, true).toLowerCase();
  const currency = String(input.currency || "INR").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new TypeError("Invalid currency code");
  const timestamp = input.timestamp ? new Date(input.timestamp) : null;
  const receivedAt = input.receivedAt ? new Date(input.receivedAt) : new Date();
  if (Number.isNaN(receivedAt.getTime())) throw new TypeError("Invalid receivedAt timestamp");
  const utr = boundedText(input.utr, "UTR", 128);
  const payerName = boundedText(input.payerName, "payerName", 128);
  const upiId = boundedText(input.upiId, "UPI ID", 128);
  const bank = boundedText(input.bank, "bank", 64);
  const accountScope = boundedText(input.accountScope, "accountScope", 64);
  const accountSuffix = boundedText(input.accountSuffix, "accountSuffix", 16);
  const rawEvidence = input.rawEvidence == null ? null : String(input.rawEvidence);
  if (rawEvidence && rawEvidence.length > 8192) throw new TypeError("rawEvidence exceeds 8192 characters");
  return {
    eventId, evidenceId, source, eventType, amountPaise, currency,
    timestamp: timestamp && !Number.isNaN(timestamp.getTime()) ? timestamp.toISOString() : null,
    timestampPrecision: input.timestampPrecision || (timestamp ? "exact" : "unknown"),
    utr: utr ? utr.replace(/\s+/g, "") : null,
    payerName,
    payerNameNormalized: normalizeName(payerName || ""),
    upiId,
    upiIdNormalized: normalizeUpiId(upiId || ""),
    bank: bank ? bank.toUpperCase() : null,
    accountScope,
    accountSuffix,
    rawEvidence,
    receivedAt: receivedAt.toISOString(),
    verificationStatus: "pending",
  };
}

function cryptoSafeId() {
  // Avoid a runtime dependency on Web Crypto so this module can be unit-tested in Node.
  return `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function validateCandidate(candidate) {
  const reasons = [];
  if (!candidate || candidate.parseStatus === "unparsed") reasons.push("unparsed_candidate");
  if (!candidate || candidate.currency !== "INR") reasons.push("unsupported_currency");
  if (!candidate || !Number.isSafeInteger(candidate.amountPaise) || candidate.amountPaise <= 0) reasons.push("invalid_amount");
  if (!candidate || !candidate.source) reasons.push("missing_source");
  if (!candidate || !candidate.evidenceId) reasons.push("missing_evidence_id");
  if (candidate?.eventType === "credit" && candidate.bank) reasons.push("bank_credit_not_candidate");
  if (candidate && !CANDIDATE_SOURCES.has(candidate.source) && !CANDIDATE_TYPES.has(candidate.eventType)) {
    reasons.push("unsupported_candidate_type");
  }
  return { valid: reasons.length === 0, reasons };
}

export function validateBankCredit(event) {
  const reasons = [];
  if (!event || event.currency !== "INR") reasons.push("unsupported_currency");
  if (!event || event.eventType !== "credit") reasons.push("not_a_credit");
  if (!event || !Number.isSafeInteger(event.amountPaise) || event.amountPaise <= 0) reasons.push("invalid_amount");
  if (!event || !event.source) reasons.push("missing_source");
  if (!event || !event.evidenceId) reasons.push("missing_evidence_id");
  if (event?.timestamp && Number.isNaN(Date.parse(event.timestamp))) reasons.push("invalid_timestamp");
  return { valid: reasons.length === 0, reasons };
}

/**
 * Score a bank credit against a Google Pay candidate.
 * Scores are explainability aids, not probabilities. A matched result is not
 * authorization to post a folio; settlement is separately and explicitly gated.
 */
export function scoreEvidence(candidate, bankEvent, options = {}) {
  const windowMs = options.windowMs ?? DEFAULT_MATCH_WINDOW_MS;
  const reasons = [];
  if (!candidate || !bankEvent) return { score: 0, reasons: ["missing_event"], eligibleForAutoMatch: false };
  if (candidate.currency !== bankEvent.currency) {
    return { score: 0, reasons: ["currency_mismatch"], eligibleForAutoMatch: false };
  }
  if (candidate.amountPaise !== bankEvent.amountPaise) {
    return { score: 0, reasons: ["amount_mismatch"], eligibleForAutoMatch: false };
  }
  if (candidate.utr && bankEvent.utr && String(candidate.utr).replace(/\s+/g, "").toUpperCase() !== String(bankEvent.utr).replace(/\s+/g, "").toUpperCase()) {
    return { score: 0, reasons: ["utr_conflict"], eligibleForAutoMatch: false };
  }
  if (candidate.upiId && bankEvent.upiId && normalizeUpiId(candidate.upiId) !== normalizeUpiId(bankEvent.upiId)) {
    return { score: 0, reasons: ["upi_id_conflict"], eligibleForAutoMatch: false };
  }

  let score = 25;
  reasons.push("exact_amount");
  if (candidate.utr && bankEvent.utr && candidate.utr === bankEvent.utr) {
    score = 100;
    reasons.push("exact_utr");
  }

  const candidateName = candidate.payerNameNormalized || normalizeName(candidate.payerName || "");
  const bankName = bankEvent.payerNameNormalized || normalizeName(bankEvent.payerName || "");
  if (candidateName && bankName && candidateName === bankName) {
    score = Math.max(score, 75);
    reasons.push("exact_normalized_payer_name");
  }

  const candidateUpi = candidate.upiIdNormalized || normalizeUpiId(candidate.upiId || "");
  const bankUpi = bankEvent.upiIdNormalized || normalizeUpiId(bankEvent.upiId || "");
  if (candidateUpi && bankUpi && candidateUpi === bankUpi) {
    score = Math.max(score, 80);
    reasons.push("exact_upi_id");
  }

  const candidateTime = Date.parse(candidate.timestamp || candidate.receivedAt || "");
  const bankTimeSource = bankEvent.timestampPrecision === "date_only"
    ? (bankEvent.receivedAt || "")
    : (bankEvent.timestamp || bankEvent.receivedAt || "");
  const bankTime = Date.parse(bankTimeSource);
  const withinWindow = Number.isFinite(candidateTime) && Number.isFinite(bankTime) &&
    Math.abs(bankTime - candidateTime) <= windowMs;
  if (withinWindow) {
    score = Math.min(100, score + 10);
    reasons.push("within_time_window");
  } else if (Number.isFinite(candidateTime) && Number.isFinite(bankTime)) {
    reasons.push("outside_time_window");
  } else {
    reasons.push("time_unavailable");
  }

  const hasStrongIdentifier = reasons.includes("exact_utr") ||
    reasons.includes("exact_normalized_payer_name") ||
    reasons.includes("exact_upi_id");
  const eligibleForAutoMatch = score >= 85 && hasStrongIdentifier && withinWindow;
  if (!hasStrongIdentifier) reasons.push("weak_amount_time_only");
  return { score, reasons, eligibleForAutoMatch };
}

function scopedBankUtrKey(event) {
  if (!event?.utr || !event?.bank) return null;
  const bank = String(event.bank).trim().toUpperCase();
  const scope = String(event.accountScope || event.accountSuffix || "UNSCOPED").trim().toUpperCase();
  const utr = String(event.utr).replace(/\s+/g, "").toUpperCase();
  return `${bank}|${scope}|${utr}`;
}

export function createPendingQueue() {
  const events = new Map();
  const bankUtrs = new Map();

  return {
    add(event) {
      if (!event?.eventId) throw new TypeError("eventId is required");
      if (events.has(event.eventId)) return { added: false, reason: "duplicate_event", item: events.get(event.eventId) };
      const utrKey = scopedBankUtrKey(event);
      if (utrKey && bankUtrs.has(utrKey)) {
        return { added: false, reason: "duplicate_utr", item: events.get(bankUtrs.get(utrKey)) || null };
      }
      const item = {
        event,
        queueStatus: "pending",
        matchScore: null,
        matchReasons: [],
        matchedCandidateId: null,
        createdAt: new Date().toISOString(),
      };
      events.set(event.eventId, item);
      if (utrKey) bankUtrs.set(utrKey, event.eventId);
      return { added: true, item };
    },
    update(eventId, patch) {
      const current = events.get(eventId);
      if (!current) throw new Error("Queue item not found");
      const next = { ...current, ...patch };
      events.set(eventId, next);
      return next;
    },
    list(status = null) {
      return [...events.values()].filter(item => !status || item.queueStatus === status);
    },
    get(eventId) {
      return events.get(eventId) || null;
    },
  };
}

/**
 * Returns a decision for one bank event against candidate notifications.
 * A unique amount/time-only candidate remains review-required because identity
 * cannot be established when the bank message omits payer/transaction identifiers.
 */
export function matchBankEvent(bankEvent, candidates, options = {}) {
  const validation = validateBankCredit(bankEvent);
  if (!validation.valid) return { decision: "reject", reason: validation.reasons.join(","), matches: [] };

  const scored = (candidates || [])
    .filter(candidate => validateCandidate(candidate).valid &&
      candidate.currency === bankEvent.currency && candidate.amountPaise === bankEvent.amountPaise)
    .map(candidate => ({ candidate, ...scoreEvidence(candidate, bankEvent, options) }))
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { decision: "pending", reason: "no_candidate", matches: [] };
  const top = scored[0];
  const second = scored[1];
  if (scored.some(item => item.reasons.includes("utr_conflict") || item.reasons.includes("upi_id_conflict"))) {
    return { decision: "review", reason: "conflicting_transaction_identity", matches: scored };
  }
  if (scored.filter(item => item.eligibleForAutoMatch).length > 1) {
    return { decision: "review", reason: "multiple_strong_candidates", matches: scored };
  }
  if (second && second.score === top.score) return { decision: "review", reason: "ambiguous_top_score", matches: scored };
  if (top.eligibleForAutoMatch) return { decision: "matched", reason: "strong_unique_match", matches: scored };
  return { decision: "review", reason: "insufficient_identity_evidence", matches: scored };
}
