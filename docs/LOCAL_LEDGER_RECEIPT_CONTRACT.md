# Local PMS Ledger Receipt Contract

**Status: implementation contract; not production approval.** The accounting mapping remains DRAFT until the accounting owner signs it in writing and a read-only reconciliation is reviewed.

## Authority boundary

- The PMS local journal (SQLite on Android / IndexedDB in browser) is the only financial ledger.
- The payment backend stores payment intents, provider evidence, device enrollment evidence, and receipt acceptance status.
- The backend must not create financial journal entries, decrement folio balances, or infer a local posting from a provider callback.
- Provider SDK callbacks are wake-up signals only. The backend independently queries the provider before accepting a receipt.
- Pay Bridge receipt submission remains disabled until its source repository is supplied and reviewed.

## Payment receipt sequence

1. The provider reports a possible capture. The backend performs a server-to-server status lookup and binds provider account, order, payment, amount, and currency.
2. The PMS posts the payment to its local journal using the payment-intent idempotency identity. The local transaction must commit once.
3. The PMS reads the entry back from durable storage and obtains its stable entry ID, canonical SHA-256 hash, and commit timestamp.
4. The enrolled device signs the receipt with its hardware-attested P-256 ECDSA key.
5. The receipt is queued locally and retried with the same receipt ID. It is not regenerated on each retry.
6. The backend rechecks provider capture, verifies the enrolled device key and signature, checks all bindings, then atomically accepts one receipt per intent.
7. Acceptance updates backend evidence/status only. It does not post or settle a financial ledger.

## Signed receipt fields

| Field | Requirement |
|---|---|
| receiptId | Stable unique receipt/idempotency identity |
| intentId | Existing captured payment intent |
| tenantId, folioId | Exact tenant and local folio binding |
| provider, environment | Provider and environment |
| providerOrderId, providerPaymentId | Exact provider-side transaction binding |
| amountMinor, currency | Positive integer minor units; INR |
| deviceId, keyId, attestationId | Active hardware-attested device/key enrollment |
| ledgerEntryId | Stable local journal entry identity |
| ledgerEntryHash | Lowercase SHA-256 of canonical local journal entry |
| readBackConfirmation | confirmed=true, same entry ID/hash, committedAt |
| issuedAt, expiresAt | Maximum five-minute lifetime |
| signature | P-256 ECDSA/SHA-256 over canonical JSON, base64url encoded |

Canonical JSON sorts object keys recursively. Unknown receipt fields are rejected. The read-back commit must be recent and must precede receipt issuance. A provider callback or a client-supplied CAPTURED status is not evidence.

## Backend acceptance invariants

- Device enrollment must be active, hardware-backed, verified-boot, and device-locked.
- The receipt signature is checked against the enrolled public key.
- Provider capture is freshly rechecked against the provider API.
- Tenant, folio, intent, provider, environment, order, payment, amount, and currency must all match.
- Receipt ID is globally unique and each intent can accept only one receipt.
- All validation occurs before identity consumption. The Firestore transaction re-reads the intent and uniqueness records; the receipt registry write is the final transaction write.
- A rejected receipt does not reserve its receipt ID.
- The transaction changes intent evidence/status only. It never writes a folio balance or financial journal.

## Offline and expiry behavior

The local journal remains durable while offline. A queued receipt retries with its original receipt ID and signature. If the five-minute receipt expires before backend acceptance, the backend rejects it; the intent remains captured and awaiting a receipt. The payment is not auto-settled, and the case requires a fresh locally read-back receipt or human reconciliation under the approved accounting procedure. Alerting and outbox delivery thresholds must be configured before production.

## Refund state machine

REQUESTED → APPROVED → PROVIDER_PENDING → PROVIDER_CONFIRMED → LOCAL_REVERSAL_POSTED → RECEIPT_ACCEPTED

- Approval is a separate owner action and must be performed by a different owner than the requester.
- Refund amounts are reserved and may not exceed the original captured amount or the remaining unrefunded amount.
- Provider-confirmed status is not a completed accounting refund.
- The local PMS must post and read back an append-only reversal before a signed reversal receipt can be accepted.
- A provider-confirmed refund without a local reversal after 30 minutes enters HUMAN_REVIEW. No background process auto-posts or auto-corrects it.
- Provider failure releases the reservation; ambiguous provider outcomes remain pending and are resolved by status lookup, never duplicate dispatch.

The current implementation defines and tests the state machine. The signed local reversal receipt bridge remains disabled pending Pay Bridge source review.

## Cutover gates

Before removing the legacy Firestore settlement path:

1. Build and verify the actual PMS local posting/receipt path on SQLite and IndexedDB.
2. Run a read-only dry-run reconciliation of existing Firestore folio balances/journal records against a redacted local PMS backup.
3. Archive the old Firestore records; do not delete them.
4. Obtain written accounting-owner approval of the mapping.
5. Complete provider sandbox UAT, Android device testing, backup/restore, monitoring, and rollback evidence.

Flags remain OFF: RECOVERY_ENABLED=false, live collection, automatic settlement, automatic refunds, cloud sync, and uiCutover=false.
