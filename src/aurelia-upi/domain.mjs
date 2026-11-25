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
  notificationEvidenceCanSettle: false
});

export const SESSION_STATUS = Object.freeze({
  CREATED: "CREATED",
  QUEUED: "QUEUED",
  ACTIVE: "ACTIVE",
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
  ACTIVE: new Set(["OBSERVED", "REVIEW_REQUIRED", "EXPIRED", "CANCELLED"]),
  OBSERVED: new Set(["REVIEW_REQUIRED", "CONFIRMED", "REJECTED"]),
  REVIEW_REQUIRED: new Set(["CONFIRMED", "REJECTED"]),
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
  const protectedFields = new Set([
    "id", "amountPaise", "currency", "rail", "vpa", "reference", "createdAt", "upiUri"
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

export function enqueueSession(sessions, session, {
  nowMs = Date.now(), activeWindowMs = DEFAULT_ACTIVE_WINDOW_MS
} = {}) {
  const rows = (Array.isArray(sessions) ? sessions : []).map(row => ({ ...row }));
  const hasOwner = rows.some(row =>
    row.vpa.toLowerCase() === session.vpa.toLowerCase() &&
    ["ACTIVE", "OBSERVED", "REVIEW_REQUIRED"].includes(row.status)
  );
  if (hasOwner) {
    return rows.concat(transitionSession(session, "QUEUED", {
      queuePosition: rows.filter(row => row.vpa.toLowerCase() === session.vpa.toLowerCase() && row.status === "QUEUED").length + 1
    }, nowMs));
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
  if (rows.some(row => row.vpa.toLowerCase() === key && ["ACTIVE", "OBSERVED", "REVIEW_REQUIRED"].includes(row.status))) {
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
  const text = String(input.text || "").trim().slice(0, 4000);
  const normalized = text.toLowerCase();
  if (!text || DEBIT_WORDS.some(word => normalized.includes(word))) {
    return { ok: false, reason: "not_an_incoming_credit" };
  }
  if (!CREDIT_WORDS.some(word => normalized.includes(word))) {
    return { ok: false, reason: "credit_language_missing" };
  }
  if (!/\bupi\b|vpa|utr|rrn|ref(?:erence)?\s*(?:no|number)/i.test(text)) {
    return { ok: false, reason: "upi_reference_missing" };
  }
  const amountMatch = /(?:₹|INR\s*|Rs\.?\s*)([0-9,]+(?:\.[0-9]{1,2})?)/i.exec(text);
  if (!amountMatch) return { ok: false, reason: "amount_missing" };
  let amountPaise;
  try { amountPaise = parseMoneyToPaise(amountMatch[1]); }
  catch { return { ok: false, reason: "amount_invalid" }; }
  const utrMatch = /\b(?:UTR|UPI\s*(?:Ref(?:erence)?|ID)|RRN|Ref(?:erence)?\s*(?:No\.?|Number)?)\s*[:#-]?\s*([A-Z0-9]{8,30})\b/i.exec(text);
  return {
    ok: true,
    evidence: {
      id: input.id || makeId("evi"),
      source: String(input.source || "MANUAL_IMPORT").slice(0, 48),
      sourcePackage: String(input.sourcePackage || "").slice(0, 160),
      amountPaise,
      currency: "INR",
      utr: utrMatch ? utrMatch[1].toUpperCase() : null,
      receivedAt: input.receivedAt || new Date().toISOString(),
      rawText: text,
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
    const expiresAt = session.expiresAt ? Date.parse(session.expiresAt) : createdAt + matchWindowMs;
    if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) return false;
    if (receivedAt < createdAt - 60_000 || receivedAt > expiresAt + processingGraceMs) return false;
    return ["ACTIVE", "OBSERVED", "REVIEW_REQUIRED", "EXPIRED", "CANCELLED"].includes(session.status);
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

export function createRefundRecord({ paymentId, amountPaise, capturedPaise, reason = "" } = {}, nowMs = Date.now()) {
  const amount = Number(amountPaise);
  const captured = Number(capturedPaise);
  if (!paymentId || !Number.isSafeInteger(amount) || amount <= 0 ||
      !Number.isSafeInteger(captured) || captured <= 0 || amount > captured) {
    throw new TypeError("Refund must reference a confirmed Aurelia UPI payment and not exceed its captured amount.");
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

export function isLegalSessionTransition(from, to) {
  return !!TRANSITIONS[from]?.has(to);
}
