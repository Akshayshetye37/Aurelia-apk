import { applyJournaledSettlement } from "./settlement-journal.mjs";

function requiredId(value, label, max = 256) {
  if (typeof value !== "string" || !value.trim() || value.length > max ||
      /[\\u0000-\\u001f\\u007f]/.test(value)) {
    throw new TypeError("Invalid " + label);
  }
  return value.trim();
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

  // Phase 0 deliberately supports only independently verified staff-review
  // commands. Manual UI and reservation advances retain their synchronous path.
  if (command.source !== "staff_review" || command.verificationConfirmed !== true) {
    const error = new Error("Only independently verified staff-review commands may use journaled settlement");
    error.code = "JOURNALED_SETTLEMENT_NOT_VERIFIED";
    throw error;
  }

  const bookingId = requiredId(String(command.bookingId ?? ""), "bookingId", 128);
  const method = requiredId(String(command.method ?? ""), "payment method", 40);
  const reference = command.reference == null ? "" : String(command.reference).trim();
  if (reference.length > 256 || /[\\u0000-\\u001f\\u007f]/.test(reference)) {
    throw new TypeError("Invalid payment reference");
  }
  const amount = command.amount;
  if (!(typeof amount === "number" || (typeof amount === "string" && /^\\d+(?:\\.\\d{1,2})?$/.test(amount.trim()))) ||
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
      bookingId, amount: Number(amount), method, reference,
      source: "staff_review", verificationConfirmed: true, idempotencyKey
    }
  };
}

export async function applyVerifiedSettlementCommand({ journal, command, project } = {}) {
  if (typeof project !== "function") throw new TypeError("Settlement projection callback is required");
  const input = journalInputFor(command);
  return applyJournaledSettlement({
    journal,
    input,
    applyProjection: (payload, record) => project(payload, record)
  });
}

export async function recoverPendingSettlements({ journal, project } = {}) {
  if (!journal || typeof journal.listPending !== "function" ||
      typeof project !== "function") {
    throw new TypeError("Settlement journal and projection callback are required");
  }
  const pending = await journal.listPending();
  const recovered = [];
  for (const record of pending) {
    const input = {
      provider: record.provider,
      ...(record.providerTransactionId
        ? { providerTransactionId: record.providerTransactionId }
        : { commandId: record.commandId }),
      payload: record.payload
    };
    const result = await applyJournaledSettlement({
      journal,
      input,
      applyProjection: (payload, currentRecord) => project(payload, currentRecord)
    });
    recovered.push({ key: record.key, result });
  }
  return { scanned: pending.length, recovered };
}
