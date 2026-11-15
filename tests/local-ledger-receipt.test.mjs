import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  createLocalLedgerReceipt,
  LOCAL_LEDGER_RECEIPT_BRIDGE_ENABLED,
  LOCAL_LEDGER_RECEIPT_TTL_MS
} from '../src/payments/local-ledger-receipt.mjs';
import { canonicalBytes } from '../src/payments/canonical.mjs';

const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const intent = {
  intentId: '123e4567-e89b-42d3-a456-426614174000',
  tenantId: 'tenant_123', folioId: 'folio_123', provider: 'razorpay',
  environment: 'test', providerOrderId: 'order_123',
  providerPaymentId: 'pay_123', amountMinor: 12500, currency: 'INR'
};
const device = {
  deviceId: 'device_123', keyId: 'key_123', attestationId: 'attestation_123',
  status: 'ACTIVE', hardwareAttested: true
};
const ledgerEntry = {
  id: 'gw:tenant_123:razorpay:test:account:pay_123',
  hash: 'a'.repeat(64), committedAt: new Date(NOW - 1000).toISOString()
};
const sign = async bytes => crypto.sign('sha256', Buffer.from(bytes), privateKey);
const readBack = async id => ({ ...ledgerEntry, id });

test('creates a backend-compatible signed receipt only after local journal read-back', async () => {
  const receipt = await createLocalLedgerReceipt({
    intent, device, ledgerEntry, readBack, sign,
    now: () => new Date(NOW), createId: () => 'receipt_123'
  });
  const { signature, ...unsigned } = receipt;
  assert.equal(receipt.receiptId, 'receipt_123');
  assert.equal(receipt.ledgerEntryId, ledgerEntry.id);
  assert.equal(receipt.ledgerEntryHash, ledgerEntry.hash);
  assert.equal(receipt.readBackConfirmation.confirmed, true);
  assert.equal(Date.parse(receipt.expiresAt) - Date.parse(receipt.issuedAt), LOCAL_LEDGER_RECEIPT_TTL_MS);
  assert.equal(
    crypto.verify('sha256', Buffer.from(canonicalBytes(unsigned)), publicKey, Buffer.from(signature, 'base64url')),
    true
  );
});

test('read-back mismatch prevents signing and receipt creation', async () => {
  let signed = false;
  await assert.rejects(createLocalLedgerReceipt({
    intent, device, ledgerEntry,
    readBack: async id => ({ ...ledgerEntry, id, hash: 'b'.repeat(64) }),
    sign: async bytes => { signed = true; return sign(bytes); },
    now: () => new Date(NOW), createId: () => 'receipt_123'
  }), /LOCAL_RECEIPT_READBACK_MISMATCH/);
  assert.equal(signed, false);
});

test('rejects missing hardware attestation and invalid provider bindings', async () => {
  await assert.rejects(createLocalLedgerReceipt({
    intent, device: { ...device, hardwareAttested: false }, ledgerEntry, readBack, sign,
    now: () => new Date(NOW)
  }), /LOCAL_RECEIPT_DEVICE_NOT_ATTESTED/);
  await assert.rejects(createLocalLedgerReceipt({
    intent: { ...intent, amountMinor: 0 }, device, ledgerEntry, readBack, sign,
    now: () => new Date(NOW)
  }), /LOCAL_RECEIPT_INTENT_INVALID/);
});

test('rejects stale local journal evidence before signing', async () => {
  await assert.rejects(createLocalLedgerReceipt({
    intent, device,
    ledgerEntry: { ...ledgerEntry, committedAt: new Date(NOW - LOCAL_LEDGER_RECEIPT_TTL_MS - 1).toISOString() },
    readBack, sign, now: () => new Date(NOW)
  }), /LOCAL_RECEIPT_LEDGER_PROOF_STALE/);
});

test('Pay Bridge receipt submission remains disabled', () => {
  assert.equal(LOCAL_LEDGER_RECEIPT_BRIDGE_ENABLED, false);
});
