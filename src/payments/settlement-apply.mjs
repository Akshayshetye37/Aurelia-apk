/**
 * Trusted settlement application boundary.
 *
 * A WebView caller can set source === "staff_review" and verificationConfirmed.
 * Those flags are NOT cryptographic proof of provider capture.
 *
 * This module therefore requires an explicit, non-forgeable authorization token
 * issued only by a trusted path (native bridge or authenticated backend command
 * that has already verified provider status, amount, currency and folio binding).
 *
 * Until that trusted issuer exists, journaled settlement remains closed to
 * unauthenticated WebView callers.
 */

import { applyJournaledSettlement } from "./settlement-journal.mjs";

const AUTHORIZATION_HEADER = "x-aurelia-settlement-authorization";

function requiredId(value, label, max = 256) {
  if (typeof value !== "string" || !value.trim() || value.length > max ||
      /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError("Invalid " + label);
  }
  return value.trim();
}

/**
 * Authorization must be a non-empty opaque token produced by a trusted issuer.
 * The token itself is validated by the supplied authorize() callback (native
 * bridge or backend session). This module never treats plain JS flags as proof.
 */
function assertAuthorized(command, authorize) {
  if (typeof authorize !== "function") {
    const error = new Error("Settlement authorization callback is required");
    error.code = "SETTLEMENT_AUTHORIZATION_REQUIRED";
    throw error;
  }
  const token = command && command.authorizationToken;
  if (typeof token !== "string" || !token.trim()) {
    const error = new Error("Settlement command lacks a trusted authorization token");
    error.code = "SETTLEMENT_NOT_AUTHORIZED";
    throw error;
  }
  const decision = authorize({
    token: token.trim(),
    provider: command.provider,
    providerTransactionId: command.providerTransactionId,
    commandId: command.commandId,
    bookingId: command.bookingId,
    amount: command.amount,
    method: command.method,
    reference: command.reference
  });
  if (decision !== true && !(decision && decision.ok === true)) {
    const error = new Error("Settlement command authorization was rejected");
    error.code = "SETTLEMENT_AUTHORIZATION_REJECTED";
    throw error;
  }
  return decision;
}

function journalInputFor(command) {
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    throw new TypeError("Verified settlement command is required");
  }
  const provider = requiredId(String(command.provider || "").toLowerCase(), "provider", 64);
  const providerTransactionId = command.providerTransactionId == null
    ? "" : requiredId(command.providerTransactionId, "providerTransactionId");
  const commandId = command.commandId == null ? "" : requiredId(command.commandId, "commandId");
  if (!!providerTransactionId === !!commandId) {
    throw new TypeError("Provide exactly one providerTransactionId or commandId");
  }

  // Flags alone are never sufficient. Authorization token is mandatory.
  if (command.source !== "staff_review" || command.verificationConfirmed !== true) {
    const error = new Error("Only independently verified staff-review commands may use journaled settlement");
    error.code = "JOURNALED_SETTLEMENT_NOT_VERIFIED";
    throw error;
  }

  const bookingId = requiredId(String(command.bookingId ?? ""), "bookingId", 128);
  const method = requiredId(String(command.method ?? ""), "payment method", 40);
  const reference = command.reference == null ? "" : String(command.reference).trim();
  if (reference.length > 256 || /[\u0000-\u001f\u007f]/.test(reference)) {
    throw new TypeError("Invalid payment reference");
  }
  const amount = command.amount;
  if (!(typeof amount === "number" || (typeof amount === "string" && /^\d+(?:\.\d{1,2})?$/.test(amount.trim()))) ||
      !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    throw new TypeError("Invalid settlement amount");
  }

  const identity = providerTransactionId
    ? "transaction:" + providerTransactionId
    : "command:" + commandId;
  const idempotencyKey = "settlement:" + provider + ":" + identity;
  if (idempotencyKey.length > 256) throw new TypeError("Settlement identity is too long");

  return {
    provider,
    ...(providerTransactionId ? { providerTransactionId } : { commandId }),
    payload: {
      bookingId,
      amount: Number(amount),
      method,
      reference,
      source: "staff_review",
      verificationConfirmed: true,
      idempotencyKey
    }
  };
}

/**
 * Apply a settlement command only when a trusted authorize() callback accepts it.
 *
 * @param {object} options
 * @param {object} options.journal - IndexedDbSettlementJournal instance
 * @param {object} options.command - settlement command including authorizationToken
 * @param {function} options.project - (payload, record) => void|Promise
 * @param {function} options.authorize - ({token, ...bindings}) => true|{ok:true} or throws/false
 */
export async function applyVerifiedSettlementCommand({
  journal,
  command,
  project,
  authorize
} = {}) {
  if (typeof project !== "function") {
    throw new TypeError("Settlement projection callback is required");
  }
  assertAuthorized(command, authorize);
  const input = journalInputFor(command);
  return applyJournaledSettlement({
    journal,
    input,
    applyProjection: (payload, record) => project(payload, record)
  });
}

/**
 * Recover PENDING journal records. Each recovery still requires the same
 * authorize callback so a compromised WebView cannot force projection.
 */
export async function recoverPendingSettlements({
  journal,
  project,
  authorize
} = {}) {
  if (!journal || typeof journal.listPending !== "function" ||
      typeof project !== "function") {
    throw new TypeError("Settlement journal and projection callback are required");
  }
  if (typeof authorize !== "function") {
    const error = new Error("Settlement authorization callback is required for recovery");
    error.code = "SETTLEMENT_AUTHORIZATION_REQUIRED";
    throw error;
  }

  const pending = await journal.listPending();
  const recovered = [];
  for (const record of pending) {
    const recoveryToken = "recovery:" + record.key + ":" + record.payloadHash;
    const decision = authorize({
      token: recoveryToken,
      provider: record.provider,
      providerTransactionId: record.providerTransactionId,
      commandId: record.commandId,
      bookingId: record.payload?.bookingId,
      amount: record.payload?.amount,
      method: record.payload?.method,
      reference: record.payload?.reference,
      recovery: true,
      journalKey: record.key,
      payloadHash: record.payloadHash
    });
    if (decision !== true && !(decision && decision.ok === true)) {
      recovered.push({
        key: record.key,
        ok: false,
        code: "SETTLEMENT_RECOVERY_NOT_AUTHORIZED"
      });
      continue;
    }

    const input = journalInputFor({
      ...record.payload,
      provider: record.provider,
      source: "staff_review",
      verificationConfirmed: true,
      authorizationToken: recoveryToken,
      ...(record.providerTransactionId
        ? { providerTransactionId: record.providerTransactionId }
        : { commandId: record.commandId })
    });
    const expectedKey = input.provider + ":" + (input.providerTransactionId
      ? "transaction:" + input.providerTransactionId
      : "command:" + input.commandId);
    if (record.key !== expectedKey) {
      throw new Error("Pending settlement journal identity is inconsistent");
    }
    const result = await applyJournaledSettlement({
      journal,
      input,
      applyProjection: (payload, currentRecord) => project(payload, currentRecord)
    });
    recovered.push({ key: record.key, result });
  }
  return { scanned: pending.length, recovered };
}

export { AUTHORIZATION_HEADER };
