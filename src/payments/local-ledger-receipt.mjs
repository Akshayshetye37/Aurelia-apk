import { canonicalBytes } from './canonical.mjs';

export const LOCAL_LEDGER_RECEIPT_TTL_MS = 5 * 60 * 1000;
export const LOCAL_LEDGER_RECEIPT_BRIDGE_ENABLED = false;

const PROVIDERS = new Set([
  'razorpay', 'cashfree', 'payu', 'phonepe', 'paytm', 'jiopay', 'ccavenue'
]);
const ID = /^[A-Za-z0-9._:-]{1,200}$/;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f-]{36}$/i;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function toBase64Url(value) {
  if (typeof value === 'string' && /^[A-Za-z0-9_-]{80,200}$/.test(value)) return value;
  if (!(value instanceof Uint8Array) || value.length < 60 || value.length > 120) {
    fail('LOCAL_RECEIPT_SIGNATURE_INVALID');
  }
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * Create a signed proof that a provider-captured payment was committed to and
 * read back from the authoritative local PMS journal. This module does not
 * post payments, contact the backend, or enable Pay Bridge.
 */
async function deterministicReceiptId(intentId, ledgerEntryId, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle) fail('LOCAL_RECEIPT_CRYPTO_UNAVAILABLE');
  const bytes = new TextEncoder().encode(intentId + ':' + ledgerEntryId);
  const digest = await cryptoImpl.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return 'rcpt_' + hex.slice(0, 48);
}

export async function createLocalLedgerReceipt({
  intent, device, ledgerEntry, readBack, sign,
  now = () => new Date(), createId = null, cryptoImpl = globalThis.crypto
} = {}) {
  if (!intent || typeof intent !== 'object' || !UUID.test(intent.intentId || '') ||
      !ID.test(intent.tenantId || '') || !ID.test(intent.folioId || '') ||
      !PROVIDERS.has(intent.provider) || !['test', 'live'].includes(intent.environment) ||
      !ID.test(intent.providerOrderId || '') || !ID.test(intent.providerPaymentId || '') ||
      !Number.isSafeInteger(intent.amountMinor) || intent.amountMinor <= 0 ||
      intent.currency !== 'INR') fail('LOCAL_RECEIPT_INTENT_INVALID');

  if (!device || device.status !== 'ACTIVE' || device.hardwareAttested !== true ||
      !ID.test(device.deviceId || '') || !ID.test(device.keyId || '') ||
      !ID.test(device.attestationId || '')) fail('LOCAL_RECEIPT_DEVICE_NOT_ATTESTED');

  if (!ledgerEntry || !ID.test(ledgerEntry.id || '') ||
      ledgerEntry.idempotencyKey !== 'payment-intent:' + intent.intentId || !HASH.test(ledgerEntry.hash || '') ||
      typeof ledgerEntry.committedAt !== 'string' ||
      !Number.isFinite(Date.parse(ledgerEntry.committedAt)) ||
      typeof readBack !== 'function' || typeof sign !== 'function') {
    fail('LOCAL_RECEIPT_LEDGER_PROOF_REQUIRED');
  }

  const clockValue = now();
  const issuedMs = clockValue instanceof Date ? clockValue.getTime() : Number(clockValue);
  if (!Number.isFinite(issuedMs)) fail('LOCAL_RECEIPT_CLOCK_INVALID');
  const issuedAt = new Date(issuedMs).toISOString();
  const committedMs = Date.parse(ledgerEntry.committedAt);
  if (committedMs > issuedMs + 30_000 ||
      issuedMs - committedMs > LOCAL_LEDGER_RECEIPT_TTL_MS) {
    fail('LOCAL_RECEIPT_LEDGER_PROOF_STALE');
  }

  const persisted = await readBack(ledgerEntry.id);
  if (!persisted || persisted.id !== ledgerEntry.id ||
      persisted.idempotencyKey !== ledgerEntry.idempotencyKey ||
      persisted.hash !== ledgerEntry.hash ||
      persisted.committedAt !== ledgerEntry.committedAt) {
    fail('LOCAL_RECEIPT_READBACK_MISMATCH');
  }

  const unsigned = {
    receiptId: createId ? createId() : await deterministicReceiptId(intent.intentId, ledgerEntry.id, cryptoImpl),
    intentId: intent.intentId,
    tenantId: intent.tenantId,
    folioId: intent.folioId,
    provider: intent.provider,
    environment: intent.environment,
    providerOrderId: intent.providerOrderId,
    providerPaymentId: intent.providerPaymentId,
    amountMinor: intent.amountMinor,
    currency: intent.currency,
    deviceId: device.deviceId,
    keyId: device.keyId,
    attestationId: device.attestationId,
    ledgerEntryId: ledgerEntry.id,
    ledgerEntryHash: ledgerEntry.hash,
    readBackConfirmation: {
      confirmed: true,
      ledgerEntryId: ledgerEntry.id,
      ledgerEntryHash: ledgerEntry.hash,
      committedAt: ledgerEntry.committedAt
    },
    issuedAt,
    expiresAt: new Date(issuedMs + LOCAL_LEDGER_RECEIPT_TTL_MS).toISOString()
  };
  if (!ID.test(unsigned.receiptId)) fail('LOCAL_RECEIPT_ID_INVALID');
  const signature = toBase64Url(await sign(canonicalBytes(unsigned)));
  return Object.freeze({ ...unsigned, signature });
}


/**
 * Reuse the same signed receipt across retries and process restarts. The
 * deterministic receipt ID is derived from intent + local journal entry;
 * an existing outbox record is returned without re-signing or changing expiry.
 */
export async function createAndQueueLocalLedgerReceipt({
  outbox, intent, device, ledgerEntry, readBack, sign,
  now = () => new Date(), cryptoImpl = globalThis.crypto
} = {}) {
  if (!outbox || typeof outbox.get !== 'function' || typeof outbox.enqueue !== 'function') {
    fail('LOCAL_RECEIPT_OUTBOX_REQUIRED');
  }
  const receiptId = await deterministicReceiptId(intent?.intentId, ledgerEntry?.id, cryptoImpl);
  const existing = await outbox.get(receiptId);
  if (existing) return { receipt: existing.receipt, record: existing, duplicate: true };
  const receipt = await createLocalLedgerReceipt({
    intent, device, ledgerEntry, readBack, sign, now,
    createId: () => receiptId, cryptoImpl
  });
  const queued = await outbox.enqueue(receipt);
  return { receipt, record: queued.record, duplicate: queued.duplicate };
}


/**
 * Adapter boundary for the authoritative local journal. postLocalEntry must
 * implement one atomic create-or-return operation keyed by payment intent ID.
 * Repeated calls therefore return the same local entry and the outbox reuses
 * the same signed receipt. This does not enable or invoke Pay Bridge.
 */
export async function postAndQueueLocalLedgerReceipt({
  postLocalEntry, outbox, intent, device, readBack, sign,
  now = () => new Date(), cryptoImpl = globalThis.crypto
} = {}) {
  if (typeof postLocalEntry !== 'function' || !intent?.intentId) {
    fail('LOCAL_RECEIPT_LOCAL_POSTER_REQUIRED');
  }
  const idempotencyKey = 'payment-intent:' + intent.intentId;
  const ledgerEntry = await postLocalEntry({ intent, idempotencyKey });
  if (!ledgerEntry || ledgerEntry.idempotencyKey !== idempotencyKey) {
    fail('LOCAL_RECEIPT_LOCAL_POST_IDEMPOTENCY_MISSING');
  }
  return createAndQueueLocalLedgerReceipt({
    outbox, intent, device, ledgerEntry, readBack, sign, now, cryptoImpl
  });
}
