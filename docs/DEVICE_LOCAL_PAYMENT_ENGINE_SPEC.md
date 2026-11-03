# Aurelia payment execution and settlement design

**Status:** implementation specification — not a production-readiness claim  
**Architecture:** Android-device-local, offline-first  
**Last reviewed:** 2026-11-04

## 1. Non-negotiable runtime boundary

Aurelia's payment engine runs inside the Android application. The supported runtime has no required cloud service, Docker appliance, LAN payment server, loopback HTTP listener, or companion process.

- The Capacitor WebView is the user interface. It may request operations through a narrow native bridge, but it never receives merchant credentials, signing keys, raw provider authorization headers, or authority to mark a payment captured or posted.
- Native Android code owns provider communication, credential access, signature/evidence verification, durable payment transitions, and reconciliation scheduling.
- Android Keystore protects encryption and device-signing keys. SQLite is the durable local source of truth. RAM is never a financial ledger.
- Offline PMS workflows remain available. Provider network operations require Internet and provider availability; unresolved operations remain explicitly unresolved until verified.
- A device behind ordinary NAT is not a public webhook endpoint. Use provider status APIs for recovery. A redirect, checkout callback, client-side success screen, or unverified webhook is never sufficient evidence of capture.

A native interface must be explicitly registered by the Android host. A JavaScript property existing on `window` is not proof that the implementation is genuine. The host must expose only the expected interface, validate every input natively, reject calls from untrusted origins/frames, and return structured asynchronous results. If the bridge is missing, malformed, unavailable, or not initialized, checkout stops before any provider request.

## 2. Responsibility boundaries

| Layer | Owns | Must never do |
|---|---|---|
| WebView / PMS UI | Staff interaction, payload preparation, local display, audit request | Hold secrets; assert payment success; mutate paid totals directly |
| Native payment engine | Credentials, provider adapters, authenticated network I/O, evidence validation, retry/reconciliation | Trust client callbacks as proof; silently convert unknown outcomes to failure |
| Device SQLite | Intent journal, provider references, idempotency keys, state history, refund journal, accounting receipt | Drop ambiguous records or overwrite immutable transaction attributes |
| PMS accounting boundary | Atomic folio mutation, ledger entry, durable acknowledgement and read-back | Credit twice; post without verified capture; acknowledge before commit |

The local gateway backend/container design is not the target runtime. Existing LAN backend code may remain for development, migration analysis, or isolated tests, but the Android application must not silently fall back to it.

## 3. Canonical payment lifecycle

Use explicit states and legal transitions rather than a single `paid` boolean.

```text
SAVED_ON_DEVICE
  ├── offline / not ready ──> READY_FOR_ONLINE
  └── online and eligible ──> ORDER_CREATING
                                ├── confirmed order ──> AWAITING_PROVIDER
                                └── uncertain result ──> RECONCILIATION_REQUIRED

AWAITING_PROVIDER
  ├── provider API confirms capture + amount/currency/reference match
  │      └──> CAPTURED_UNPOSTED
  ├── provider API confirms terminal failure ──> FAILED
  └── timeout, mismatch, unavailable API ──> RECONCILIATION_REQUIRED

CAPTURED_UNPOSTED
  ├── atomic PMS folio + ledger receipt commit ──> POSTED_TO_FOLIO
  └── accounting conflict / unavailable folio ──> CAPTURED_UNPOSTED (held)

Any immutable-field mismatch ──> CONFLICT (manual review; no automatic credit)
```

Rules:

1. Create the local intent before network dispatch. Give it a cryptographically random transaction ID and stable idempotency key.
2. Persist provider order/reference identifiers before accepting subsequent status changes.
3. Treat timeouts after dispatch as ambiguous. Query the provider using the known reference before retrying an operation that could create a second charge.
4. Only an authenticated provider response verified by the provider-specific adapter can establish capture.
5. Match transaction identity, provider, environment, order/payment reference, amount in minor units, currency, and expected merchant account before accepting evidence.
6. Do not downgrade a verified capture to failure because a later poll times out.
7. Do not post the PMS folio from a WebView callback or directly from provider response parsing. Pass a verified capture to the accounting boundary.
8. Keep conflict and ambiguous states visible and recoverable. Never delete them to make a dashboard look clean.

## 4. Atomic PMS folio settlement

The folio database is the accounting authority. Settlement must be performed inside the same SQLite transaction that writes the folio ledger entry and idempotency receipt.

Required transaction shape:

1. Begin a write transaction (`BEGIN IMMEDIATE` on SQLite where appropriate).
2. Load the payment journal row and require `CAPTURED_UNPOSTED`.
3. Look up the accounting receipt by transaction ID and idempotency key.
4. If a receipt exists, compare every immutable field (folio, amount, currency, property, transaction). Return the original receipt only when all fields match; otherwise raise a conflict.
5. Validate that the folio exists, is open/eligible, belongs to the expected property/guest, and can accept the amount under the PMS's partial-payment and balance rules.
6. Insert one immutable folio payment/ledger entry and one unique accounting receipt.
7. Update the local payment state to `POSTED_TO_FOLIO` in the same transaction.
8. Commit. Re-read the folio balance and receipt from durable storage.
9. Only after successful read-back may an upstream delivery/command be acknowledged.

A standalone update such as `amount_paid = amount_paid + amount` is not an acceptable accounting implementation. It can bypass the canonical ledger, balance rules, audit history, and concurrent-write protection. The implementation must use Aurelia's real schema and existing accounting functions; do not invent table names or assume that `better-sqlite3` is the Android runtime database.

Exactly-once network delivery is not promised. The design is at-least-once/replayable delivery plus a unique local accounting key, atomic commit, durable receipt, and idempotent read-back.

## 5. Device-local command/outbox policy

If a future synchronization/outbox is used, it must be local to the device and must not create a second required appliance.

- Each command has an immutable command ID, monotonically increasing local sequence, transaction ID, idempotency key, canonical payload, and SHA-256 payload hash.
- Claim/lease state is persisted transactionally. A lease expiry allows redelivery; it does not imply that the previous attempt failed.
- Use bounded exponential backoff with jitter for transient failures. Do not retry deterministic validation failures.
- After the attempt ceiling, preserve the record as `AMBIGUOUS_RECONCILIATION`; do not discard it.
- A command is complete only after the PMS accounting receipt is committed and read back.
- Store audit events append-only. Corrections are new events, not destructive edits to historical evidence.

Suggested delivery states: `PENDING`, `LEASED`, `DELIVERING`, `ACKNOWLEDGED`, `PROCESSED`, `AMBIGUOUS_RECONCILIATION`, `CONFLICT`. These are transport states, not substitutes for the payment lifecycle.

## 6. Refund lifecycle

Refunds have their own durable record and idempotency key. Never model a refund as a negative payment or delete the original capture.

Suggested states:

`REQUESTED` → `SUBMITTED` → `PROVIDER_PENDING` → `RECONCILIATION_REQUIRED` or `SUCCEEDED` / `FAILED`.

Required fields include refund ID, original transaction ID, unique refund idempotency key, amount_minor, currency, provider refund reference, status, timestamps, and immutable request/evidence hashes.

- Enforce cumulative successful + pending refund amounts against the refundable captured amount.
- Verify the refund with the provider's authoritative status API.
- A timeout after refund submission is ambiguous; query by provider refund reference/idempotency key before resubmission.
- Update the PMS folio/refund accounting entry idempotently only after provider-confirmed refund success.
- Provider refund support is account-, product-, and API-version-dependent. Unsupported refunds remain disabled.

## 7. Provider adapter contract

The seven requested providers remain Razorpay, Cashfree, PayU, PhonePe, Paytm, JioPay, and CCAvenue. A registry entry or credential form does not constitute an adapter.

Each adapter must document and test:

- exact API product and API version;
- test/UAT/production base URLs and environment mapping;
- credential fields and whether the provider permits secret use from a device application;
- authenticated order creation and deterministic idempotency behavior;
- status lookup and authoritative capture semantics;
- webhook/callback signature verification, if applicable;
- amount/currency/reference mapping and maximum identifier lengths;
- refund submission, status lookup, partial-refund behavior, and idempotency;
- timeouts, rate limits, retryable errors, and ambiguous outcomes.

Do not embed a production secret in JavaScript, APK resources, source control, or logs. Android Keystore protects encrypted local storage but does not make a compromised endpoint equivalent to a merchant-controlled server. If a provider's terms or API security model require server-side secret custody, that provider cannot be represented as production-ready in a device-only deployment.

## 8. Native bridge contract

The bridge is a narrow capability API, not a generic JavaScript-to-native method tunnel.

Minimum operations (all asynchronous and schema-validated):

- `getEngineStatus()`: reports engine version, initialization, key protection level, and supported provider capabilities without exposing secrets.
- `createPaymentIntent(payload)`: validates and persists an intent; does not claim payment.
- `startCheckout(transactionId)`: native code validates the saved intent and dispatches only when online and provider configuration is eligible.
- `getPaymentStatus(transactionId)`: returns the persisted state and reconciliation requirement.
- `requestRefund(payload)`: validates and persists a refund request; execution remains subject to provider support and authorization.
- `listPendingOperations(limit)`: returns safe operational metadata only.

The bridge must reject unknown methods, oversized payloads, invalid identifiers, unsupported providers/environments, duplicate/mutated requests, and calls from unexpected WebView origins or frames. Use explicit origin allowlisting and Android-side validation. Do not expose arbitrary file, shell, HTTP, database, or credential methods.

## 9. Acceptance matrix

| Scenario | Expected result |
|---|---|
| Native bridge absent or initialization fails | Checkout blocked before provider dispatch; audit event written |
| Device offline | PMS core remains usable; gateway intent remains queued/unresolved |
| Duplicate checkout dispatch | Same transaction/idempotency identity; no second charge |
| Provider order request times out | Mark ambiguous; query provider before any retry |
| Callback says success but provider API says pending | Remain pending/reconciliation required |
| Provider reports capture with wrong amount/currency/reference | Conflict; no folio credit |
| Two concurrent folio postings for same transaction | One ledger entry; second returns same receipt |
| Same transaction ID with changed folio/amount/currency | Conflict; no mutation |
| Process dies after folio commit but before acknowledgement | Replay finds durable receipt; no duplicate credit |
| Provider API unavailable during recovery | Preserve unresolved state; bounded retry |
| Refund request times out | Reconcile before resubmission |
| Device key is missing/revoked or software-backed where hardware is required | Sensitive operation fails closed |
| Database migration from prior version | Existing records preserved; migration tested on copied fixtures |

## 10. Release gates

Live processing remains disabled until all applicable gates pass:

1. Native bridge is registered in the actual Capacitor Android host and tested against the production WebView origin policy.
2. Credential encryption, key lifecycle, backup/restore behavior, device loss/revocation, and secret redaction are tested.
3. Each provider adapter passes contract tests and provider sandbox tests for the merchant's actual enabled products.
4. Payment verification, ambiguous recovery, duplicate events, and refund reconciliation pass fault-injection tests.
5. The atomic folio boundary uses the actual Aurelia PMS database schema and passes concurrency, crash-recovery, migration, and durable read-back tests.
6. Android debug/release builds and physical-device acceptance pass on supported Android versions.
7. Security review confirms provider terms permit the chosen device-local credential model.

Until then, the application is not ready to collect gateway payments. Do not label a provider "complete" because its name appears in the UI or vault.
