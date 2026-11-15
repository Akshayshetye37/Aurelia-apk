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
export async function createLocalLedgerReceipt({
  intent, device, ledgerEntry, readBack, sign,
  now = () => new Date(), createId = () => globalThis.crypto.randomUUID()
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

  if (!ledgerEntry || !ID.test(ledgerEntry.id || '') || !HASH.test(ledgerEntry.hash || '') ||
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
      persisted.hash !== ledgerEntry.hash ||
      persisted.committedAt !== ledgerEntry.committedAt) {
    fail('LOCAL_RECEIPT_READBACK_MISMATCH');
  }

  const unsigned = {
    receiptId: createId(),
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
