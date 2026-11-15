import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createLocalLedgerReceiptService } from '../src/intents/local-ledger-receipt.mjs';

const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const canonical = value => JSON.stringify(Object.fromEntries(
  Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
));

function fixture(overrides = {}) {
  const unsigned = {
    receiptId: 'receipt_01HZX8M4K7',
    intentId: '123e4567-e89b-42d3-a456-426614174000',
    tenantId: 'tenant_01',
    folioId: 'folio_01',
    provider: 'razorpay',
    environment: 'test',
    providerOrderId: 'order_123',
    providerPaymentId: 'pay_123',
    amountMinor: 12500,
    currency: 'INR',
    deviceId: 'device_01',
    keyId: 'device-key-01',
    attestationId: 'attestation_01',
    ledgerEntryId: 'ledger_entry_01',
    ledgerEntryHash: 'a'.repeat(64),
    readBackConfirmation: {
      confirmed: true,
      ledgerEntryId: 'ledger_entry_01',
      ledgerEntryHash: 'a'.repeat(64),
      committedAt: new Date(NOW - 1000).toISOString()
    },
    issuedAt: new Date(NOW - 1000).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(),
    ...overrides
  };
  const signature = crypto.sign(null, Buffer.from(canonical(unsigned)), privateKey).toString('base64url');
  return { ...unsigned, signature };
}

function setup({ intentOverrides = {}, attestationOverrides = {}, providerOverrides = {} } = {}) {
  const intent = {
    intentId: '123e4567-e89b-42d3-a456-426614174000',
    tenantId: 'tenant_01', folioId: 'folio_01', provider: 'razorpay',
    environment: 'test', providerOrderId: 'order_123', providerPaymentId: 'pay_123',
    amountMinor: 12500, currency: 'INR', state: 'CAPTURED',
    accountingStatus: 'AWAITING_LOCAL_RECEIPT',
    ...intentOverrides
  };
  const writes = [];
  const repository = {
    async getIntent(intentId) { return intentId === intent.intentId ? intent : null; },
    async getReceipt(receiptId) { return null; },
    async getIntentReceipt(intentId) { return null; },
    async acceptReceiptAtomically(input) { writes.push(input); return { accepted: true, duplicate: false }; }
  };
  const service = createLocalLedgerReceiptService({
    repository,
    clock: () => NOW,
    verifyDeviceAttestation: async () => ({
      verified: true, deviceId: 'device_01', keyId: 'device-key-01',
      attestationId: 'attestation_01', publicKey, hardwareBacked: true,
      ...attestationOverrides
    }),
    verifyProviderCapture: async () => ({
      captured: true, provider: 'razorpay', environment: 'test',
      providerOrderId: 'order_123', providerPaymentId: 'pay_123',
      amountMinor: 12500, currency: 'INR', ...providerOverrides
    })
  });
  return { service, writes, intent };
}

test('accepts a captured payment only after signed local journal post and read-back proof', async () => {
  const { service, writes } = setup();
  const result = await service.accept(fixture());
  assert.deepEqual(result, { accepted: true, duplicate: false });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].receipt.receiptId, 'receipt_01HZX8M4K7');
  assert.equal(writes[0].receipt.ledgerEntryId, 'ledger_entry_01');
  assert.equal(writes[0].receipt.ledgerEntryHash, 'a'.repeat(64));
  assert.equal(writes[0].receipt.readBackConfirmation.confirmed, true);
});

test('rejects forged signatures without consuming receipt identity', async () => {
  const { service, writes } = setup();
  const forged = { ...fixture(), ledgerEntryHash: 'b'.repeat(64) };
  await assert.rejects(service.accept(forged), /receipt_signature_invalid/);
  assert.equal(writes.length, 0);
});

test('requires hardware-attested enrollment for the exact device key', async () => {
  const { service, writes } = setup({ attestationOverrides: { hardwareBacked: false } });
  await assert.rejects(service.accept(fixture()), /hardware_attested_device_key_required/);
  assert.equal(writes.length, 0);
});

test('rejects receipt whose ledger read-back does not match the posted entry', async () => {
  const { service, writes } = setup();
  const receipt = fixture({
    readBackConfirmation: {
      confirmed: true, ledgerEntryId: 'different_entry',
      ledgerEntryHash: 'c'.repeat(64), committedAt: new Date(NOW - 1000).toISOString()
    }
  });
  await assert.rejects(service.accept(receipt), /ledger_readback_mismatch/);
  assert.equal(writes.length, 0);
});

test('rejects expired receipts and receipts outside the maximum lifetime', async () => {
  const { service, writes } = setup();
  await assert.rejects(service.accept(fixture({
    issuedAt: new Date(NOW - 600_000).toISOString(),
    expiresAt: new Date(NOW - 1).toISOString()
  })), /receipt_expired/);
  await assert.rejects(service.accept(fixture({
    issuedAt: new Date(NOW - 1).toISOString(),
    expiresAt: new Date(NOW + 600_000).toISOString()
  })), /receipt_lifetime_exceeded/);
  assert.equal(writes.length, 0);
});

test('binds receipt to tenant, folio, intent, provider, payment, amount and currency', async () => {
  const { service, writes } = setup();
  const receipt = fixture({ amountMinor: 12501 });
  // Re-sign so the mismatch is semantic, not a signature failure.
  const { signature, ...unsigned } = receipt;
  const signed = { ...unsigned, signature: crypto.sign(null, Buffer.from(canonical(unsigned)), privateKey).toString('base64url') };
  await assert.rejects(service.accept(signed), /receipt_intent_binding_mismatch/);
  assert.equal(writes.length, 0);
});

test('requires independent provider capture verification to match the receipt', async () => {
  const { service, writes } = setup({ providerOverrides: { providerPaymentId: 'pay_other' } });
  await assert.rejects(service.accept(fixture()), /provider_capture_binding_mismatch/);
  assert.equal(writes.length, 0);
});

test('validates before atomically consuming receipt ID; a rejected attempt leaves it available', async () => {
  const { service, writes } = setup();
  const invalid = fixture({ readBackConfirmation: { confirmed: false } });
  await assert.rejects(service.accept(invalid), /ledger_readback_required/);
  assert.equal(writes.length, 0);
  const valid = await service.accept(fixture());
  assert.equal(valid.accepted, true);
  assert.equal(writes.length, 1);
});

test('rejects an already accepted intent receipt and never posts a second local entry', async () => {
  const { service, writes } = setup();
  // The repository's atomic transaction reports the existing intent receipt.
  service.repository.acceptReceiptAtomically = async () => ({ accepted: true, duplicate: true });
  const result = await service.accept(fixture());
  assert.deepEqual(result, { accepted: true, duplicate: true });
  assert.equal(writes.length, 0);
});

test('rejects an attestation key that does not match receipt identity', async () => {
  const { service, writes } = setup({ attestationOverrides: { deviceId: 'device_other' } });
  await assert.rejects(service.accept(fixture()), /device_attestation_binding_mismatch/);
  assert.equal(writes.length, 0);
});
