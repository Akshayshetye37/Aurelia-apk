import crypto from 'node:crypto';

const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;
const CLOCK_SKEW_MS = 30 * 1000;
const HASH = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,200}$/;

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + canonicalJson(value[key])
    ).join(',') + '}';
  }
  return JSON.stringify(value);
}

function unsignedReceipt(receipt) {
  const { signature, ...unsigned } = receipt;
  return unsigned;
}

function assertReceiptShape(receipt) {
  const allowed = new Set([
    'receiptId', 'intentId', 'tenantId', 'folioId', 'provider', 'environment',
    'providerOrderId', 'providerPaymentId', 'amountMinor', 'currency',
    'deviceId', 'keyId', 'attestationId', 'ledgerEntryId', 'ledgerEntryHash',
    'readBackConfirmation', 'issuedAt', 'expiresAt', 'signature'
  ]);
  const readBackAllowed = new Set(['confirmed', 'ledgerEntryId', 'ledgerEntryHash', 'committedAt']);
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
      Object.keys(receipt).some(key => !allowed.has(key)) ||
      !receipt.readBackConfirmation || typeof receipt.readBackConfirmation !== 'object' ||
      Array.isArray(receipt.readBackConfirmation) ||
      Object.keys(receipt.readBackConfirmation).some(key => !readBackAllowed.has(key)) ||
      !IDENTIFIER.test(receipt.receiptId || '') ||
      !/^[0-9a-f-]{36}$/i.test(receipt.intentId || '') ||
      !IDENTIFIER.test(receipt.tenantId || '') ||
      !IDENTIFIER.test(receipt.folioId || '') ||
      !IDENTIFIER.test(receipt.deviceId || '') ||
      !IDENTIFIER.test(receipt.keyId || '') ||
      !IDENTIFIER.test(receipt.attestationId || '') ||
      !IDENTIFIER.test(receipt.ledgerEntryId || '') ||
      !HASH.test(receipt.ledgerEntryHash || '') ||
      !Number.isSafeInteger(receipt.amountMinor) || receipt.amountMinor <= 0 ||
      receipt.currency !== 'INR' ||
      typeof receipt.provider !== 'string' ||
      !['razorpay', 'cashfree', 'payu', 'phonepe', 'paytm', 'jiopay', 'ccavenue'].includes(receipt.provider) ||
      typeof receipt.environment !== 'string' ||
      typeof receipt.providerOrderId !== 'string' || !receipt.providerOrderId ||
      typeof receipt.providerPaymentId !== 'string' || !receipt.providerPaymentId ||
      typeof receipt.signature !== 'string' || !/^[A-Za-z0-9_-]{80,200}$/.test(receipt.signature) ||
      !receipt.readBackConfirmation || typeof receipt.readBackConfirmation !== 'object') {
    throw new TypeError('invalid_local_ledger_receipt');
  }
}

function assertReceiptLifetime(receipt, now, maxAgeMs) {
  const issuedAt = Date.parse(receipt.issuedAt);
  const expiresAt = Date.parse(receipt.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) ||
      issuedAt > now + CLOCK_SKEW_MS) {
    throw new Error('receipt_timestamp_invalid');
  }
  if (expiresAt <= now) throw new Error('receipt_expired');
  if (expiresAt <= issuedAt || expiresAt - issuedAt > maxAgeMs) {
    throw new Error('receipt_lifetime_exceeded');
  }
}

function assertReadBack(receipt) {
  const proof = receipt.readBackConfirmation;
  if (proof.confirmed !== true) throw new Error('ledger_readback_required');
  if (proof.ledgerEntryId !== receipt.ledgerEntryId ||
      proof.ledgerEntryHash !== receipt.ledgerEntryHash ||
      !Number.isFinite(Date.parse(proof.committedAt))) {
    throw new Error('ledger_readback_mismatch');
  }
}

function assertIntentBinding(receipt, intent) {
  const fields = [
    'intentId', 'tenantId', 'folioId', 'provider', 'environment',
    'providerOrderId', 'providerPaymentId', 'amountMinor', 'currency'
  ];
  if (!intent || fields.some(field => intent[field] !== receipt[field])) {
    throw new Error('receipt_intent_binding_mismatch');
  }
  if (intent.state !== 'CAPTURED' ||
      !['AWAITING_LOCAL_RECEIPT', 'RECEIPT_ACCEPTED'].includes(intent.accountingStatus)) {
    throw new Error('payment_intent_not_awaiting_local_receipt');
  }
}

function assertProviderCapture(receipt, evidence) {
  const fields = [
    'provider', 'environment', 'providerOrderId', 'providerPaymentId',
    'amountMinor', 'currency'
  ];
  if (!evidence || evidence.captured !== true ||
      fields.some(field => evidence[field] !== receipt[field])) {
    throw new Error('provider_capture_binding_mismatch');
  }
}

function assertAttestation(receipt, attestation) {
  if (!attestation || attestation.verified !== true || attestation.hardwareBacked !== true) {
    throw new Error('hardware_attested_device_key_required');
  }
  if (attestation.deviceId !== receipt.deviceId ||
      attestation.keyId !== receipt.keyId ||
      attestation.attestationId !== receipt.attestationId ||
      !attestation.publicKey) {
    throw new Error('device_attestation_binding_mismatch');
  }
}

export function createLocalLedgerReceiptService({
  repository,
  verifyDeviceAttestation,
  verifyProviderCapture,
  clock = () => Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS
}) {
  if (!repository || typeof repository.getIntent !== 'function' ||
      typeof repository.acceptReceiptAtomically !== 'function' ||
      typeof verifyDeviceAttestation !== 'function' ||
      typeof verifyProviderCapture !== 'function' ||
      !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1_000 || maxAgeMs > DEFAULT_MAX_AGE_MS) {
    throw new TypeError('local_ledger_receipt_dependencies_required');
  }

  return Object.freeze({
    async accept(receipt) {
      assertReceiptShape(receipt);
      const now = Number(clock());
      if (!Number.isFinite(now)) throw new TypeError('receipt_clock_invalid');
      assertReceiptLifetime(receipt, now, maxAgeMs);
      assertReadBack(receipt);

      // Resolve current server-side state and both independent trust sources
      // before asking the repository to consume either idempotency identity.
      const intent = await repository.getIntent(receipt.intentId);
      assertIntentBinding(receipt, intent);

      const [attestation, providerEvidence] = await Promise.all([
        verifyDeviceAttestation({
          deviceId: receipt.deviceId, keyId: receipt.keyId,
          attestationId: receipt.attestationId, intentId: receipt.intentId
        }),
        verifyProviderCapture({
          intentId: receipt.intentId, provider: receipt.provider,
          environment: receipt.environment, providerOrderId: receipt.providerOrderId,
          providerPaymentId: receipt.providerPaymentId
        })
      ]);
      assertAttestation(receipt, attestation);
      assertProviderCapture(receipt, providerEvidence);

      const signatureBytes = Buffer.from(receipt.signature, 'base64url');
      const validSignature = crypto.verify(
        'sha256',
        Buffer.from(canonicalJson(unsignedReceipt(receipt))),
        attestation.publicKey,
        signatureBytes
      );
      if (!validSignature) throw new Error('receipt_signature_invalid');

      // This operation MUST use one database transaction: re-read the intent,
      // reject receipt-ID collisions and an existing receipt for this intent,
      // then create the receipt registry record as the final write. It must not
      // create or mutate any financial ledger/folio balance in Firestore.
      const result = await repository.acceptReceiptAtomically({
        receipt: structuredClone(receipt),
        expectedIntent: {
          intentId: intent.intentId, tenantId: intent.tenantId,
          folioId: intent.folioId, provider: intent.provider,
          environment: intent.environment, providerOrderId: intent.providerOrderId,
          providerPaymentId: intent.providerPaymentId,
          amountMinor: intent.amountMinor, currency: intent.currency
        },
        acceptedAt: new Date(now).toISOString()
      });
      if (!result || result.accepted !== true ||
          typeof result.duplicate !== 'boolean') {
        throw new Error('local_ledger_receipt_commit_not_confirmed');
      }
      return { accepted: true, duplicate: result.duplicate };
    }
  });
}
