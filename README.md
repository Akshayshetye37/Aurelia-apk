# Aurelia PMS

Aurelia is an offline-first property-management system with a planned device-local Android payment engine.

> **Payment release status: NOT READY FOR LIVE PAYMENT COLLECTION.** The native payment engine, complete provider adapters, verified settlement-to-folio integration, refund workflow and physical-device acceptance are not yet complete. Live activation must remain disabled.

## Architecture decision

Aurelia's Android application is the operational runtime and local source of truth. It does not require an Aurelia cloud service, Docker appliance, LAN payment server, local HTTP server or companion process.

- **Offline-first PMS:** bookings, guests, rooms, check-in/out, folios, invoices, reports, cash/manual UPI recording and local backups must remain usable without Internet.
- **Online-only gateway operations:** provider order creation, hosted checkout, payment verification, refunds and reconciliation require Internet and provider availability. Offline intents remain explicitly queued; they are never shown as collected payments.
- **Native trust boundary:** Android native code owns merchant credentials, provider API calls, cryptographic verification and payment state transitions. WebView JavaScript is presentation and cannot mark a payment captured or posted.
- **Durability:** Android Keystore protects encryption/signing keys. SQLite stores payment intents, provider references, idempotency keys, evidence state, recovery work and accounting receipts. Device RAM is not a financial ledger.
- **No public webhook assumption:** an Android device behind ordinary NAT is not a public webhook receiver. Recover payment state through authenticated provider status APIs.
- **Accounting separation:** provider capture is not a PMS folio credit. Only verified capture evidence can enter the idempotent PMS accounting boundary; a durable receipt must be read back before the payment is marked posted.

## Gateway scope

The agreed provider catalogue is:

1. Razorpay
2. Cashfree
3. PayU
4. PhonePe
5. Paytm
6. JioPay
7. CCAvenue

A provider name in a registry or credential form does not mean its adapter is implemented. Each provider requires documented API/version mapping, credential-policy review, authenticated order creation, authoritative status verification, timeout recovery, and refund support/tests where available. Do not embed production secrets in JavaScript, APK resources or source control. If a provider requires server-side secret custody, it must remain unavailable in the device-only deployment.

## Current implementation checkpoint

- [x] Android credential-vault template recognizes seven provider credential sets and environment labels.
- [x] Local payment-journal template supports the seven provider IDs and includes a v1-to-v2 migration path for the earlier Razorpay/Cashfree records.
- [x] WebView checkout fails closed when the native payment engine is absent; the legacy LAN checkout is not a fallback.
- [x] Device-local architecture and implementation contract are documented.
- [ ] Register and implement the native payment bridge in the actual Capacitor Android host.
- [ ] Implement and test the seven provider adapters against current official API documentation and merchant sandbox accounts.
- [ ] Implement provider-authoritative verification and crash-safe reconciliation.
- [ ] Integrate verified capture with Aurelia's actual PMS folio schema using one atomic transaction and durable idempotency receipt.
- [ ] Implement independently journaled refund execution and reconciliation where supported.
- [ ] Complete automated tests, Android builds, migration tests and physical-device acceptance.

No successful APK build, provider sandbox acceptance or live deployment is claimed by this checkpoint.

## Payment lifecycle

```text
SAVED_ON_DEVICE
  -> READY_FOR_ONLINE
  -> ORDER_CREATED
  -> AWAITING_PROVIDER
  -> CAPTURED_UNPOSTED
  -> POSTED_TO_FOLIO

Uncertain outcome -> RECONCILIATION_REQUIRED
Verified terminal failure -> FAILED
Immutable evidence mismatch -> CONFLICT (manual review)
```

Retries must reuse the original transaction/idempotency identity. A timeout is ambiguous, not proof of failure. Never create a replacement charge until the provider has been queried using the original references. Exactly-once network delivery is not promised; the design relies on replay-safe operations, unique accounting keys, atomic local commits and durable receipt read-back.

## Repository layout

| Path | Purpose |
|---|---|
| `index.html` | PMS WebView application |
| `android/templates/` | Native Android implementation templates |
| `payment-backend/` | Legacy/development backend and provider research code; not a required runtime dependency for the device-only target |
| `docs/DEVICE_LOCAL_PAYMENT_ENGINE_SPEC.md` | Normative device-local payment, bridge, ledger, refund and acceptance contract |
| `docs/LOCAL_FIRST_HYBRID_PAYMENT_ARCHITECTURE.md` | Architecture decision and historical design context |
| `tests/` | Application and payment contract tests |

## Engineering rules

- Never store financial state only in memory.
- Never trust a WebView callback, redirect, screenshot, SMS or notification as payment proof.
- Never log or expose credentials, authorization headers, private keys or full sensitive provider payloads.
- Use integer minor units for money; do not use floating-point arithmetic for accounting.
- Preserve ambiguous and conflicting records for reconciliation; never silently discard them.
- Use Aurelia's real folio and ledger schema. Do not introduce a parallel accounting model or update a paid total without a canonical ledger entry.
- Keep live activation disabled until every applicable release gate in the device-local specification has passed.

## Build and test

Root application:

```bash
npm install
npm test
npm run build
```

Android synchronization (after the Android project has been added and configured):

```bash
npm run android:sync
```

Payment-backend development tests (legacy/dev tooling only; not the device-only production runtime):

```bash
cd payment-backend
npm install
npm test
```

A passing JavaScript test suite is not equivalent to Android build acceptance, provider sandbox certification, or live-payment approval.

## Architecture and acceptance documents

- [Device-local payment engine specification](docs/DEVICE_LOCAL_PAYMENT_ENGINE_SPEC.md)
- [Device-local architecture decision](docs/LOCAL_FIRST_HYBRID_PAYMENT_ARCHITECTURE.md)
