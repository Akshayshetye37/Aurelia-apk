/**
 * Aurelia UPI domain model.
 * Direct UPI only: a QR, app intent, SMS or notification is never settlement proof.
 */
export const AURELIA_UPI_POLICY = Object.freeze({
  rail: "AURELIA_UPI",
  currency: "INR",
  enabledRails: Object.freeze(["AURELIA_UPI"]),
  externalPaymentGateways: false,
  automaticSettlement: false,
  notificationEvidenceCanSettle: false,
  paymentWindowMs: 5 * 60 * 1000,
  verificationWindowMs: 30 * 1000
});

export const SESSION_STATUS = Object.freeze({
  CREATED: "CREATED",
  QUEUED: "QUEUED",
  ACTIVE: "ACTIVE",
  PROCESSING: "PROCESSING",
  OBSERVED: "OBSERVED",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
  CONFIRMED: "CONFIRMED",
  EXPIRED: "EXPIRED",
  CANCELLED: "CANCELLED",
  REJECTED: "REJECTED"
});

const TRANSITIONS = Object.freeze({
  CREATED: new Set(["QUEUED", "ACTIVE", "CANCELLED"]),
  QUEUED: new Set(["ACTIVE", "EXPIRED", "CANCELLED"]),
  ACTIVE: new Set(["PROCESSING", "OBSERVED", "REVIEW_REQUIRED", "EXPIRED", "CANCELLED"]),
  PROCESSING: new Set(["REVIEW_REQUIRED", "EXPIRED", "CANCELLED"]),
  OBSERVED: new Set(["REVIEW_REQUIRED", "CONFIRMED", "REJECTED"]),
  REVIEW_REQUIRED: new Set(["CONFIRMED", "REJECTED", "CANCELLED"]),
  EXPIRED: new Set(["REVIEW_REQUIRED"]),
  CANCELLED: new Set(["REVIEW_REQUIRED"]),
  CONFIRMED: new Set(),
  REJECTED: new Set()
});

const MAX_AMOUNT_PAISE = 100_000_000_000;
const DEFAULT_ACTIVE_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_PROCESSING_GRACE_MS = 30 * 1000;

export function parseMoneyToPaise(value) {
  const raw = String(value ?? "").trim().replace(/[₹,\s]/g, "");
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) throw new TypeError("Enter a valid INR amount with up to two decimal places.");
  const rupees = Number(match[1]);
  const paise = Number((match[2] || "").padEnd(2, "0") || "0");
  const total = rupees * 100 + paise;
  if (!Number.isSafeInteger(total) || total <= 0 || total > MAX_AMOUNT_PAISE) {
    throw new RangeError("The payment amount is outside the supported Aurelia UPI limit.");
  }
  return total;
}

export function formatPaise(amountPaise) {
  if (!Number.isSafeInteger(amountPaise) || amountPaise < 0) {
    throw new TypeError("amountPaise must be a non-negative safe integer.");
  }
  return "₹" + (amountPaise / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

export function normalizeVpa(value) {
  const vpa = String(value || "").trim();
  if (vpa.length > 128 || !/^[A-Za-z0-9._-]{2,64}@[A-Za-z0-9.-]{2,64}$/.test(vpa)) {
    throw new TypeError("Enter a valid Aurelia UPI ID (VPA) in name@bank format.");
  }
  return vpa;
}

function safeText(value, max, label) {
  const text = String(value ?? "").trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new TypeError(label + " is invalid.");
  }
  return text;
}

function makeId(prefix) {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return prefix + "_" + uuid;
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return prefix + "_" + Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

export function buildUpiIntent({
  vpa, payeeName, amountPaise, reference, note = "Aurelia UPI payment"
} = {}) {
  const pa = normalizeVpa(vpa);
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0 || amountPaise > MAX_AMOUNT_PAISE) {
    throw new TypeError("A positive integer amount in paise is required.");
  }
  const pn = safeText(payeeName || "Aurelia", 80, "Payee name");
  const tr = safeText(reference, 64, "Aurelia UPI reference");
  const tn = safeText(note, 80, "Payment note");
  const params = new URLSearchParams({
    pa, pn, am: (amountPaise / 100).toFixed(2), cu: "INR", tr, tn
  });
  return "upi://pay?" + params.toString();
}

export function createPaymentSession(input = {}, nowMs = Date.now()) {
  const amountPaise = Number.isSafeInteger(input.amountPaise)
    ? input.amountPaise : parseMoneyToPaise(input.amount);
  const vpa = normalizeVpa(input.vpa);
  const id = input.id || makeId("aup");
  const reference = safeText(input.reference || ("AUR" + id.replace(/[^A-Za-z0-9]/g, "").slice(-18).toUpperCase()), 64, "Reference");
  const session = {
    id,
    kind: ["folio", "restaurant", "general"].includes(input.kind) ? input.kind : "general",
    bookingId: input.bookingId == null ? null : safeText(input.bookingId, 128, "Booking ID"),
    tableId: input.tableId == null ? null : safeText(input.tableId, 64, "Table ID"),
    guestName: String(input.guestName || "").trim().slice(0, 100),
    room: String(input.room || "").trim().slice(0, 64),
    amountPaise,
    currency: "INR",
    rail: "AURELIA_UPI",
    vpa,
    payeeName: safeText(input.payeeName || "Aurelia", 80, "Payee name"),
    reference,
    note: String(input.note || "Aurelia UPI payment").trim().slice(0, 80),
    status: SESSION_STATUS.CREATED,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: null,
    verificationExpiresAt: null,
    customerMarkedPaidAt: null,
    observedEvidenceId: null,
    confirmedAt: null,
    confirmedBy: null,
    transactionReference: null,
    queuePosition: null,
    previewOnly: false
  };
  session.upiUri = buildUpiIntent({
    vpa: session.vpa, payeeName: session.payeeName,
    amountPaise, reference, note: session.note
  });
  return session;
}

export function transitionSession(session, nextStatus, patch = {}, nowMs = Date.now()) {
  if (!session || !Object.hasOwn(TRANSITIONS, session.status)) {
    throw new TypeError("Unknown Aurelia UPI session state.");
  }
  if (!TRANSITIONS[session.status].has(nextStatus)) {
    const error = new Error("Illegal Aurelia UPI transition: " + session.status + " → " + nextStatus);
    error.code = "AURELIA_UPI_ILLEGAL_TRANSITION";
    throw error;
  }
  if (nextStatus === SESSION_STATUS.CONFIRMED && patch.manualVerified !== true) {
    const error = new Error("Aurelia UPI settlement requires explicit operator verification.");
    error.code = "AURELIA_UPI_MANUAL_VERIFICATION_REQUIRED";
    throw error;
  }
  const protectedFields = new Set([
    "id", "kind", "bookingId", "tableId", "guestName", "room",
    "amountPaise", "currency", "rail", "vpa", "payeeName", "reference",
    "note", "createdAt", "upiUri"
  ]);
  for (const key of Object.keys(patch)) {
    if (protectedFields.has(key)) throw new TypeError("Immutable Aurelia UPI field: " + key);
  }
  return {
    ...session,
    ...patch,
    status: nextStatus,
    updatedAt: new Date(nowMs).toISOString()
  };
}

export function markCustomerPaid(session, nowMs = Date.now(), verificationWindowMs = DEFAULT_PROCESSING_GRACE_MS) {
  if (!session || session.status !== SESSION_STATUS.ACTIVE) {
    throw new TypeError("Only the active Aurelia UPI request can be marked as customer-reported paid.");
  }
  return transitionSession(session, SESSION_STATUS.PROCESSING, {
    customerMarkedPaidAt: new Date(nowMs).toISOString(),
    verificationExpiresAt: new Date(nowMs + verificationWindowMs).toISOString()
  }, nowMs);
}

export function enqueueSession(sessions, session, {
  nowMs = Date.now(), activeWindowMs = DEFAULT_ACTIVE_WINDOW_MS
} = {}) {
  const rows = (Array.isArray(sessions) ? sessions : []).map(row => ({ ...row }));
  const key = session.vpa.toLowerCase();
  const sameVpa = rows.filter(row => String(row.vpa || "").toLowerCase() === key);
  const hasOwner = sameVpa.some(row =>
    ["ACTIVE", "PROCESSING", "OBSERVED", "REVIEW_REQUIRED"].includes(row.status)
  );
  const queuedBefore = sameVpa.filter(row => row.status === "QUEUED").length;
  if (hasOwner || queuedBefore > 0) {
    const queued = transitionSession(session, "QUEUED", {
      queuePosition: queuedBefore + 1
    }, nowMs);
    const updated = rows.concat(queued);
    // If the previous owner has just been released, promote the oldest existing
    // request before admitting the new request to the active slot.
    return hasOwner ? updated : promoteNextSession(updated, key, { nowMs, activeWindowMs }).sessions;
  }
  return rows.concat(transitionSession(session, "ACTIVE", {
    expiresAt: new Date(nowMs + activeWindowMs).toISOString(),
    queuePosition: 0
  }, nowMs));
}

export function promoteNextSession(sessions, vpa, {
  nowMs = Date.now(), activeWindowMs = DEFAULT_ACTIVE_WINDOW_MS
} = {}) {
  const rows = (Array.isArray(sessions) ? sessions : []).map(row => ({ ...row }));
  const key = String(vpa || "").toLowerCase();
  if (rows.some(row => row.vpa.toLowerCase() === key && ["ACTIVE", "PROCESSING", "OBSERVED", "REVIEW_REQUIRED"].includes(row.status))) {
    return { sessions: rows, promoted: null };
  }
  const next = rows
    .filter(row => row.vpa.toLowerCase() === key && row.status === "QUEUED")
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
  if (!next) return { sessions: rows, promoted: null };
  const promoted = transitionSession(next, "ACTIVE", {
    expiresAt: new Date(nowMs + activeWindowMs).toISOString(),
    queuePosition: 0
  }, nowMs);
  const updated = rows.map(row => row.id === promoted.id ? promoted : row);
  let position = 0;
  for (const row of updated
    .filter(row => row.vpa.toLowerCase() === key && row.status === "QUEUED")
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))) {
    row.queuePosition = ++position;
  }
  return { sessions: updated, promoted };
}

const CREDIT_WORDS = ["credited", "received", "received from", "paid you", "money received", "payment successful"];
const DEBIT_WORDS = ["debited", "you paid", "sent to", "money sent", "payment failed", "declined", "reversed", "refund", "otp"];

export function parseIncomingUpiNotification(input = {}) {
  const text = String(input.text || "").trim().slice(0, 4096);
  if (!text) return { ok: false, reason: "empty_alert" };
  const normalized = text.replace(/\s+/g, " ");
  const lower = normalized.toLowerCase();
  const creditPattern = /\\b(?:credited|received(?:\\s+from)?|deposit(?:ed)?|payment\\s+received|money\\s+received|upi\\/cr|paid\\s+you|transferred\\s+to\\s+your\\s+(?:a\\/c|account|wallet)|added\\s+to\\s+your\\s+(?:account|wallet))\\b/i;
  if (!creditPattern.test(normalized)) return { ok: false, reason: "credit_language_missing" };
  // Any explicit outgoing/failure wording makes the whole alert ineligible.
  // "Payment successful" is not a credit signal: debit alerts commonly use it.
  const debitPattern = /\\b(?:debited|withdrawn|deducted|spent|paid\\s+to|sent\\s+to|money\\s+sent|you\\s+paid|payment\\s+failed|declined|reversed|refund|otp)\\b/i;
  if (debitPattern.test(normalized)) return { ok: false, reason: "debit_alert_rejected" };

  // Remove balance/limit clauses before amount extraction so an available balance is not mistaken for the credit.
  const balancePattern = /(?:(?:avl|avail|available|tot|total|ledger|clear|curr|current)(?:\s+(?:bal|balance|limit))?|bal|balance)\b[\s:=-]*(?:(?:rs\.?|inr|₹)\s*)?\b\d[\d,]{0,15}(?:\.\d{1,2})?/gi;
  const sanitized = normalized.replace(balancePattern, " ").trim();
  const amountPatterns = [
    /(?:credited\s*(?:with|by|for)?|received|deposit(?:ed)?)\s*[:=-]?\s*(?:(?:rs\b\.?|inr\b)|₹)?[\s:=-]*([\d,]+(?:\.\d{1,2})?)/i,
    /(?:(?:rs\b\.?|inr\b)|₹)[\s:=-]*([\d,]+(?:\.\d{1,2})?)/i,
    /(?:^|[^\w.])([\d,]+(?:\.\d{1,2})?)[\s:=-]*(?:(?:rs\b\.?|inr\b)|₹)/i,
    /(?:credited|received|deposit|cr)[\s\w:]*?([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)[\s\w:]*?(?:credited|received|deposit|cr)/i,
    /\b(\d{1,6}\.\d{2})\b/
  ];
  let amountText = null;
  for (const pattern of amountPatterns) {
    const match = pattern.exec(sanitized);
    if (match) {
      amountText = match[1] || match[2] || null;
      if (amountText) break;
    }
  }
  if (!amountText) return { ok: false, reason: "amount_missing" };
  let amountPaise;
  try { amountPaise = parseMoneyToPaise(amountText.replace(/,/g, "")); }
  catch { return { ok: false, reason: "amount_invalid" }; }

  const utrPatterns = [
    /(?:upi\s*ref(?:erence)?\s*(?:no\.?|num)?|utr(?:\s*no\.?)?|rrn(?:\s*no\.?)?|txn\s*(?:id|ref|#)?|transaction\s*id|ref\s*no\.?)[\s:=-]+([a-zA-Z0-9_-]{8,30})/i,
    /(?:upi\/(?:[0-9]+\/|cr\/)([a-zA-Z0-9_-]{8,30}))/i,
    /\b([0-9]{12})\b/
  ];
  let utr = null;
  for (const pattern of utrPatterns) {
    const match = pattern.exec(normalized);
    if (match?.[1]) { utr = match[1].trim().toUpperCase(); break; }
  }
  const vpaMatch = /([a-zA-Z0-9._-]{2,64}@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*)/i.exec(normalized);
  const parsedAt = input.receivedAt ? new Date(input.receivedAt) : new Date();
  return {
    ok: true,
    evidence: {
      id: input.id || makeId("evi"),
      source: String(input.source || "MANUAL_IMPORT").slice(0, 48),
      sourcePackage: String(input.sourcePackage || "").slice(0, 160),
      amountPaise,
      currency: "INR",
      utr,
      senderVpa: vpaMatch ? vpaMatch[1].trim() : null,
      receivedAt: Number.isFinite(parsedAt.getTime()) ? parsedAt.toISOString() : new Date().toISOString(),
      rawText: normalized,
      status: "UNMATCHED",
      suggestedSessionId: null,
      createdAt: new Date().toISOString()
    }
  };
}

export function matchEvidenceToSessions(evidence, sessions, {
  matchWindowMs = 5 * 60 * 1000,
  processingGraceMs = DEFAULT_PROCESSING_GRACE_MS
} = {}) {
  if (!evidence || !Number.isSafeInteger(evidence.amountPaise) || evidence.amountPaise <= 0) {
    return { decision: "UNMATCHED", reason: "invalid_evidence", candidates: [] };
  }
  const receivedAt = Date.parse(evidence.receivedAt);
  if (!Number.isFinite(receivedAt)) return { decision: "UNMATCHED", reason: "invalid_timestamp", candidates: [] };
  const candidates = (Array.isArray(sessions) ? sessions : []).filter(session => {
    if (session.currency !== "INR" || session.rail !== "AURELIA_UPI" ||
        session.amountPaise !== evidence.amountPaise) return false;
    const createdAt = Date.parse(session.createdAt);
    const expiryValues = [session.expiresAt, session.verificationExpiresAt].filter(Boolean).map(Date.parse).filter(Number.isFinite);
    const expiresAt = expiryValues.length ? Math.max(...expiryValues) : createdAt + matchWindowMs;
    if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) return false;
    if (receivedAt < createdAt - 60_000 || receivedAt > expiresAt + processingGraceMs) return false;
    return ["ACTIVE", "PROCESSING", "OBSERVED", "REVIEW_REQUIRED", "EXPIRED", "CANCELLED"].includes(session.status);
  });
  if (candidates.length > 1) {
    return { decision: "AMBIGUOUS", reason: "multiple_exact_amount_time_candidates", candidates };
  }
  if (candidates.length === 1) {
    const session = candidates[0];
    const exactUtr = !!(evidence.utr && session.customerUtr &&
      evidence.utr.toUpperCase() === String(session.customerUtr).toUpperCase());
    return {
      decision: "REVIEW_REQUIRED",
      reason: exactUtr ? "exact_utr_and_amount" : "unique_amount_time_candidate",
      suggestedSessionId: session.id,
      candidates,
      exactUtr
    };
  }
  return { decision: "UNMATCHED", reason: "no_exact_amount_time_candidate", candidates: [] };
}

export function createRefundRecord({
  paymentId, amountPaise, capturedPaise, alreadyRefundedPaise = 0, reason = ""
} = {}, nowMs = Date.now()) {
  const amount = Number(amountPaise);
  const captured = Number(capturedPaise);
  const alreadyRefunded = Number(alreadyRefundedPaise);
  if (!paymentId || !Number.isSafeInteger(amount) || amount <= 0 ||
      !Number.isSafeInteger(captured) || captured <= 0 ||
      !Number.isSafeInteger(alreadyRefunded) || alreadyRefunded < 0 ||
      amount + alreadyRefunded > captured) {
    throw new TypeError("The cumulative refund amount cannot exceed the confirmed Aurelia UPI payment amount.");
  }
  return {
    id: makeId("ref"),
    paymentId: safeText(paymentId, 128, "Payment ID"),
    amountPaise: amount,
    currency: "INR",
    status: "MANUAL_TRANSFER_REQUIRED",
    reason: String(reason).trim().slice(0, 240),
    transferReference: null,
    confirmedBy: null,
    createdAt: new Date(nowMs).toISOString(),
    rail: "AURELIA_UPI"
  };
}

export function completeRefundRecord(refund, {
  transferReference, manualVerified
} = {}, nowMs = Date.now()) {
  if (!refund || refund.status !== "MANUAL_TRANSFER_REQUIRED") {
    throw new TypeError("Only an outstanding manual Aurelia UPI refund can be completed.");
  }
  if (manualVerified !== true) {
    throw new TypeError("Refund completion requires explicit operator verification.");
  }
  const reference = safeText(transferReference, 30, "Refund transfer reference").toUpperCase();
  if (!/^[A-Z0-9]{8,30}$/.test(reference)) {
    throw new TypeError("Enter a valid bank transfer UTR or reference.");
  }
  return {
    ...refund,
    status: "REFUND_RECORDED",
    transferReference: reference,
    confirmedBy: "LOCAL_OPERATOR",
    manualVerified: true,
    completedAt: new Date(nowMs).toISOString()
  };
}

export function isLegalSessionTransition(from, to) {
  return !!TRANSITIONS[from]?.has(to);
}
