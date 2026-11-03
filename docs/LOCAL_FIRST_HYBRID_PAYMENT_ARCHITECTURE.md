# Aurelia device-local payment architecture

**Decision date:** 2026-11-04  
**Authority:** This document defines the target deployment. Older LAN/cloud appliance descriptions in archived notes are historical only.

## 1. Deployment model

Aurelia PMS and its payment runtime execute inside the Android application. No cloud service, Docker appliance, LAN payment server, loopback HTTP service or companion process is required. Android production networking must keep cleartext traffic disabled (`usesCleartextTraffic=false`) and use HTTPS for provider API calls.

```text
ANDROID DEVICE — OFFLINE-FIRST RUNTIME
┌────────────────────────────────────────────────────────────────────┐
│ Aurelia PMS WebView                                                 │
│ UI, staff workflows, booking/folio presentation                     │
│ No merchant secrets; no direct payment-state authority              │
│                         │                                           │
│              Narrow, validated native bridge                        │
│                         ▼                                           │
│ Native Android payment engine                                       │
│ Keystore-backed identity + encrypted credential vault               │
│ Provider adapters + authoritative response verification             │
│ SQLite intent journal + payment/refund ledgers + recovery outbox     │
│                         │                                           │
│                         ▼                                           │
│ Canonical Aurelia PMS SQLite accounting boundary                    │
│ Folio ledger + idempotency receipt + durable read-back               │
└─────────────────────────┬──────────────────────────────────────────┘
                          │ outbound HTTPS, when Internet is available
                          ▼
       Razorpay | Cashfree | PayU | PhonePe | Paytm | JioPay | CCAvenue
```

## 2. Operational availability

| Capability | Offline | Online |
|---|---:|---:|
| Bookings, guests, rooms, check-in/out | Yes | Yes |
| Folios, invoices, reports, local audit | Yes | Yes |
| Cash/manual UPI recording | Yes, with local audit | Yes |
| Local backup/export | Yes | Yes |
| Gateway order creation / hosted checkout | No | If provider is configured and eligible |
| Provider status verification | No | Yes |
| Refund submission/status | No | If implemented and supported |
| Provider reconciliation | No | Yes |

An offline gateway intent is not a payment. Do not show it as collected, settled, or posted.

## 3. Trust and execution boundaries

**WebView:** renders the PMS and requests narrow operations. It cannot hold merchant secrets, generate authoritative provider evidence, execute arbitrary native methods, or set a payment to captured/posted.

**Native Android engine:** validates every bridge payload, owns credentials and provider network I/O, verifies provider evidence, persists state transitions, and schedules recovery. The engine must be registered in the actual Capacitor host and must expose a versioned capability handshake. A JavaScript flag alone is not proof of native availability.

**Keystore:** protects encryption and device-signing keys. Prefer StrongBox where available and report the actual security level. Hardware-backed device identity proves key possession only; it does not prove provider payment capture or PMS accounting.

**SQLite:** durable financial state lives on disk. RAM is transient. Intent, provider references, idempotency keys, evidence, refunds, audit events and settlement receipts must survive process death.

**PMS accounting:** the canonical PMS folio/ledger schema is the authority for guest balances. A separate payment journal may track provider operations, but folio posting must be atomic with its idempotency receipt when both share one SQLite database.

**Network:** the Android device makes outbound HTTPS requests. Do not assume a device behind NAT can receive public provider webhooks. Recover by querying the provider's authoritative status API. Provider callbacks and redirects are notifications, not proof.

## 4. Payment and accounting lifecycle

```text
SAVED_ON_DEVICE -> READY_FOR_ONLINE -> ORDER_CREATED -> AWAITING_PROVIDER
  -> CAPTURED_UNPOSTED -> POSTED_TO_FOLIO

Timeout / unknown remote result -> RECONCILIATION_REQUIRED
Verified terminal decline -> FAILED
Immutable data or evidence mismatch -> CONFLICT (manual review)
```

- Persist the intent before dispatch.
- Use a stable transaction ID and idempotency key for the same logical attempt.
- A timeout after dispatch is ambiguous. Query the provider using the original reference before retrying.
- Independently verify merchant account, provider, environment, order/payment reference, amount in integer minor units and currency.
- A verified provider capture enters CAPTURED_UNPOSTED; it is not yet a PMS credit.
- Post through the canonical folio accounting transaction. Compare all immutable fields on replay.
- Commit one ledger entry and one unique receipt; read both back before marking POSTED_TO_FOLIO.
- If process death occurs after commit but before acknowledgement, replay must return the original receipt without a second credit.

Exactly-once network delivery is not claimed. Use at-least-once/replayable operations with database-enforced idempotency and durable receipts.

## 5. Device-local outbox and recovery

The outbox is an on-device recovery queue, not a LAN appliance or network service. It can hold provider status checks, refund status checks and verified-capture folio projection work.

Suggested delivery states: PENDING, LEASED, DELIVERING, ACKNOWLEDGED, PROCESSED, AMBIGUOUS_RECONCILIATION, CONFLICT.

Claim a job and assign its lease token/expiry inside one SQLite transaction. Every subsequent update must match the current lease token. Expired leases may be reclaimed; they do not prove the previous operation failed. Use bounded exponential backoff with jitter, a retry ceiling and an administrative reconciliation queue. Never discard a potentially captured payment.

Keep append-only business command events separate from mutable delivery state. A monotonically increasing sequence is useful for ordering and audit, but it does not replace idempotency keys, provider references, or payload integrity checks.

## 6. Refund accounting

A refund is a separate operation, not a deletion or negative edit of the original payment. Persist a refund ID, original transaction ID, unique refund idempotency key, amount in minor units, provider refund reference, status, timestamps and evidence.

Enforce cumulative successful and pending refunds against the captured amount. Verify refund status through the provider's authoritative API. A timeout after refund submission is ambiguous and must be reconciled before resubmission. Update PMS refund/reversal accounting idempotently only after provider-confirmed success. Keep refunds disabled for adapters that have not passed their tests.

## 7. Seven-provider scope and security policy

The target providers are Razorpay, Cashfree, PayU, PhonePe, Paytm, JioPay and CCAvenue. Stripe and BillDesk are outside the agreed scope.

For every provider, document the exact product/API version, environment mapping, credentials, authentication/signature scheme, identifier constraints, idempotency semantics, order creation, status lookup, refund support, timeout handling and sandbox tests.

A registry entry or credential form is not an adapter. Do not claim an adapter is complete until its documented flows and tests pass.

A device-local vault is not equivalent to trusted server-side secret custody. A rooted, instrumented or lost device is a real risk. If provider terms or API design require server-side secret custody, do not place production secrets in the APK; disable that provider in device-only mode.

## 8. Acceptance gates

1. Actual Android host registers the narrow native bridge; missing/incompatible bridge blocks checkout before provider dispatch.
2. Bridge validates origin, frame, method, payload schema, size, identifiers and allowed provider/environment.
3. Secrets are encrypted at rest, excluded from WebView/logs/analytics/backups/shared storage, and recoverable only through controlled owner workflows.
4. Each provider passes current official API contract tests and merchant sandbox tests.
5. Timeout, duplicate, callback replay, invalid signature, amount/currency mismatch and process-death recovery tests pass.
6. Actual PMS folio schema is integrated; concurrent replay produces one ledger entry and one durable receipt.
7. Refund limits, provider reconciliation and PMS reversal entries pass tests where supported.
8. Offline PMS, migration, backup/restore and physical-device acceptance pass.
9. Provider policy review permits the device-local credential model.
10. Live activation remains disabled until all applicable gates are approved.

## 9. Repository checkpoint

Implemented foundations on this branch include the seven-provider credential-vault template, a local payment-journal template with migration groundwork, a fail-closed WebView checkout guard, and this architecture/specification.

Still outstanding: native bridge registration and runtime, complete provider adapters, provider-authoritative verification/reconciliation, refund lifecycle, canonical PMS folio projector, integration/fault-injection tests, Android build and physical-device acceptance.

**Release status: not approved for gateway payment collection.**