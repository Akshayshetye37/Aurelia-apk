# Local-first hybrid payment architecture

## Goal

Aurelia remains usable when the Internet and optional LAN appliance are unavailable. The Android device is the local operational source for PMS records and a durable journal of payment requests. A payment is not considered collected merely because a request was stored locally, sent to the LAN appliance, or returned from a checkout screen.

## Routing responsibilities

| Layer | Owns | Must not own |
|---|---|---|
| Android PMS + local storage | Bookings, folios, local operation journal, offline UI, retry queue, encrypted credential vault | Final provider payment authority or self-declared captured status |
| Optional LAN appliance | Local administration, durable dispatch coordination, provider adapter execution where configured, signed command delivery, local recovery | Trusting unsigned device claims or accepting client-supplied payment success |
| Provider APIs | Order/payment/refund facts and provider references | Aurelia's folio balance |
| Trusted payment backend | Provider credentials, order creation, signature/status verification, webhook inbox, idempotency and reconciliation | Replacing the PMS folio ledger |
| PMS accounting boundary | Exactly-once receipt/credit posting after authoritative verification | Posting on a client callback alone |

Cloud connectivity is not required for ordinary PMS operations. It is required for whichever provider operations or remote verification endpoints the merchant has selected. An optional LAN appliance may reduce dependence on a public cloud-hosted Aurelia service, but it does not remove the payment provider's Internet requirement.

## Device journal implementation

android/templates/LocalPaymentLedger.java is copied into the generated Android app by scripts/patch-android.js. It uses Android SQLite directly because the current native shell is Java/Capacitor and does not currently include a Room/Kotlin persistence stack. This avoids adding a second ORM and unnecessary dependencies.

Each journal row contains a stable transaction/idempotency identifier, provider and test/live environment, PMS folio reference, integer amount in paise and INR currency, local dispatch status, cloud synchronization status, and timestamps.

The native bridge exposes window.AureliaLocalPaymentLedger:

- create(entry) — idempotently records a local payment request.
- listPending(limit) — returns the oldest pending sync rows.
- updateLocalStatus(id, status) — advances local dispatch bookkeeping only.

Allowed local statuses are SAVED_ON_DEVICE, SENT_TO_LAN, PROCESSED_BY_LAN, and RECONCILIATION_REQUIRED. Invalid transitions are rejected. Repeating a transaction ID with different provider, environment, folio or amount is an idempotency conflict.

**Important boundary:** this journal is an offline-safe intent/outbox foundation, not a complete payment flow. It deliberately has no client-callable method to mark a payment captured, set cloud sync to SYNCED, or post a folio receipt. Those transitions require a trusted signed backend result and the PMS accounting transaction. Until that integration is implemented, rows remain pending and no UI should describe them as paid.

## Retry and synchronization rules

1. Persist the request before attempting LAN or Internet dispatch.
2. Use the same stable idempotency key for every retry.
3. If the provider request may have reached the provider but the response is lost, mark the outcome ambiguous and query provider status. Never create a new order blindly.
4. A LAN timeout is not proof that the appliance did not process the request.
5. A WebView checkout callback is presentation state only. The backend independently verifies amount, currency, provider order/payment binding and signature/status.
6. Only the trusted settlement coordinator may acknowledge cloud synchronization after a durable server receipt. A client must not set SYNCED because an HTTP request returned 200.
7. A verified provider payment and a posted PMS folio credit are separate states. Reconciliation must resolve the gap without duplicate ledger posting.

The current bridge exposes pending rows for a future sync worker. A WorkManager worker is intentionally not scheduled until the authenticated sync endpoint, signed acknowledgement format, retry contract and conflict semantics are implemented. A generic worker that uploads arbitrary local payment amounts would create an unsafe second source of truth.

## Network security

The Android manifest patch currently sets usesCleartextTraffic=false and a strict network security configuration. Keep this default.

Do not add a broad cleartext exception for 192.168.1.x, a wildcard private subnet, or .local. Android network security domain rules are host-based, not a safe wildcard subnet firewall; cleartext HTTP also permits LAN interception and credential theft.

Use HTTPS for the LAN appliance with a stable hostname and a certificate trusted by the device (for example, an owner-managed private CA installed through a controlled enrollment flow). Keep public/cloud APIs HTTPS-only. Do not add placeholder certificate pins: incorrect or expired pins can brick connectivity. If certificate pinning is introduced, ship a tested backup pin and rotation plan.

## Credential handling

Merchant API secrets remain in the native Android Keystore-backed vault for device-local storage. They must never be copied into IndexedDB, localStorage, PMS JSON backups, logs, analytics, APK resources or GitHub. Keystore encryption protects credentials at rest; it does not make an Android device a trusted server. A rooted or instrumented device may observe secrets while they are in use. For provider order creation and signature verification, prefer a trusted LAN payment service with restricted network access, or a properly secured remote payment backend.

## Acceptance gates before real collections

- Merchant sandbox checkout works for each supported provider.
- Provider order creation uses stable idempotency and records provider order IDs.
- Server-side payment status and signature verification are tested.
- Webhook replay, duplicates, invalid signatures and delayed events are tested.
- Ambiguous dispatch recovery queries provider status rather than creating a second order.
- Verified payments post to the actual PMS folio exactly once in a database transaction.
- Partial payments, overpayments, refunds and reversals have defined accounting behavior.
- Device process death, LAN outage, Internet outage, app upgrade and restore are tested.
- Live collection remains disabled until all above gates pass.