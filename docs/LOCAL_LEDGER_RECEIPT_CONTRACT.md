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


## Implementation status and remaining boundary

- The PMS receipt builder and browser IndexedDB outbox are implemented and tested with a P-256 test signer. The outbox reuses a deterministic receipt ID across restarts, retries with bounded backoff, and moves expired/rejected records to review-required status.
- Device enrollment now returns the backend-registered key ID and attestation ID to the PMS. The PMS-side receipt signer is not wired to a production native/Pay Bridge operation.
- The separate com.aurelia.paybridge service source is still missing. No payment/refund IPC operation or receipt submission is enabled.
- The Android local payment database is currently a SQLiteOpenHelper store, not the canonical SQLCipher accounting database. The Android receipt outbox and actual SQLite/SQLCipher journal posting integration remain blocked on the canonical database migration and Pay Bridge review.
- The backend acceptance endpoint and atomic evidence registry are implemented. Its provider capture and device attestation checks are independent of the PMS callback.
- The legacy Firestore settlement writer remains in source for audit/reconciliation but is protected by LEGACY_FIRESTORE_SETTLEMENT_ENABLED=false and is not imported by the Cloud Run server.

## Read-only legacy reconciliation input

The backend provides scripts/reconcile-legacy-folios.mjs. It accepts normalized JSON exports with this shape:

- folios: tenantId, folioId, currency, balanceMinor
- entries: intentId, tenantId, folioId, providerPaymentId, amountMinor, currency, and type (PAYMENT_CREDIT or REFUND_DEBIT)

Run only against a redacted local PMS export and a read-only Firestore export:

node scripts/reconcile-legacy-folios.mjs --local <local-export.json> --firestore <firestore-export.json>

The script reports MATCH or REVIEW_REQUIRED and never writes, repairs, archives, or deletes either source. No reconciliation has been run yet because the redacted PMS backup and accounting-owner approval have not been supplied. Historical Firestore records must be archived, not deleted, after the dry-run and written approval.


## Scheduled refund exception monitoring

The backend now includes a dedicated Cloud Run Job at `payment-backend/src/refunds/review-scan-job.mjs`. Terraform provisions a Cloud Scheduler trigger every five minutes using an OAuth service-account token to invoke the Cloud Run Jobs API. The job scans provider-confirmed refunds, promotes those missing a local reversal after 30 minutes to `HUMAN_REVIEW`, and creates one durable `paymentRefundReviewAlerts/{refundId}` record. Each new alert emits a structured Cloud Logging event at severity `ALERT`.

The scanner is idempotent and never calls a provider or writes a financial ledger entry. The queue GET endpoint remains a read/refresh path, not the scheduler. The schedule becomes active only after the Terraform change is applied to the staging project; no cloud resources were provisioned from this repository change.
