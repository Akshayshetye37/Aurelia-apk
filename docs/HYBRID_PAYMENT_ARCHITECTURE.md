# Aurelia PMS — Hybrid Production Payment Architecture

**Decision:** Architecture A — hybrid production architecture.  
**Status:** Architecture selected; implementation is in progress and is NOT approved for live collection.  
**Scope:** Razorpay, Cashfree, PayU, PhonePe, Paytm, JioPay and CCAvenue.

## 1. Decision and deployment topology

The Android application remains the offline-first PMS client. A trusted, publicly reachable HTTPS backend is the payment authority and the only component allowed to possess merchant API secrets. The backend is deployed as a managed service (Cloud Run or equivalent) with workload identity, a managed secret store, durable transactional storage, and public HTTPS ingress for provider webhooks.

```text
AURELIA ANDROID / CAPACITOR
  PMS UI + local offline database
  No merchant secrets; no payment-success authority
       | HTTPS + authenticated user/device identity
       v
TRUSTED PAYMENT BACKEND (public HTTPS; managed runtime)
  AuthN/AuthZ + tenant/property isolation
  Provider registry + seven independent adapters
  Secret Manager + durable payment/refund state
  Webhook ingress + provider status reconciliation
  Idempotent accounting/outbox coordinator
       | HTTPS, provider-specific auth/signatures
       +--> Razorpay / Cashfree / PayU / PhonePe / Paytm / JioPay / CCAvenue
       |
       +--> durable payment events / settlement outbox
                 |
                 v
       authenticated device sync / canonical folio projector
```

The existing `payment-backend/src/server.mjs` Firebase Admin + Firestore + Google Secret Manager runtime is the selected backend foundation. The local Docker/LAN runtime in `src/local-server.mjs` is not the production payment authority: a private LAN appliance is not a reliable public webhook receiver and must not be used as a substitute for public HTTPS ingress. It may remain available for local development and administration only.

## 2. Security boundaries

- Merchant API secrets, salts, webhook secrets and provider signing material exist only in backend Secret Manager. Never place them in the APK, JavaScript bundle, localStorage, IndexedDB, Android preferences, source control or client-visible API responses.
- Use workload identity / Application Default Credentials for Secret Manager and Firestore. Do not ship service-account JSON keys.
- The Android client authenticates users and devices. The backend independently authorizes tenant, property, role, folio ownership, amount and currency. Client-supplied tenant IDs are never authorization evidence.
- Provider webhooks terminate at the public backend over HTTPS. Verify each provider's signature against exact raw request bytes and the correct environment secret. Deduplicate event IDs/payload hashes, then independently fetch authoritative provider status before accepting a financial state transition.
- A checkout redirect, SDK callback, client success screen or webhook alone does not prove payment capture.
- Apply request-size limits, strict schemas, origin policy for browser calls, rate limits, audit logging with redaction, secret rotation, least-privilege IAM and TLS-only ingress.
- Use integer minor units for amounts. Never use floating-point values for ledger calculations.

## 3. Unified internal API

The mobile app talks only to Aurelia's API. Provider-specific details remain inside adapters.

- `POST /v1/payments/intents` — reserve an intent against an authoritative open folio; requires an Idempotency-Key.
- `POST /v1/payments/:intentId/checkout` — create/retrieve provider order and return only public checkout data.
- `GET /v1/payments/intents/:intentId` — return backend-authoritative payment state.
- `POST /v1/payments/:intentId/reconcile` — trigger rate-limited authoritative provider status lookup.
- `POST /v1/payments/:intentId/refunds` — request bounded full/partial refund with a separate idempotency key.
- `GET /v1/payments/:intentId/refunds/:refundId` — return refund state.
- `POST /v1/webhooks/:provider/:environment` — provider-specific raw-body webhook ingress; public route, no browser session, signature verification and event deduplication required.
- Device event and acknowledgement routes — authenticated, ordered, replay-safe synchronization.

The existing server/repository currently implements only a subset of this contract. Do not expose routes or advertise capabilities until backing adapter, persistence, authorization and tests are present.

## 4. Provider adapter contract

Each provider implements the same Aurelia-facing operations but retains its own authentication and protocol:

```ts
interface PaymentProvider {
  validateCredentials(): Promise<ValidationResult>;
  createOrder(input: CreateOrderInput): Promise<ProviderOrder>;
  findOrderByReference(input: OrderReference): Promise<ProviderOrderLookup>;
  getPaymentStatus(input: StatusLookup): Promise<ProviderPaymentStatus>;
  verifyWebhook(rawBody: Buffer, headers: Headers): Promise<VerifiedWebhook>;
  createRefund(input: RefundInput): Promise<ProviderRefund>;
  getRefundStatus(input: RefundLookup): Promise<ProviderRefundStatus>;
}
```

An adapter is enabled only when its exact product/API version, merchant account eligibility, environment mapping, request signing, webhook verification, status lookup, idempotency semantics, refund semantics and sandbox contract tests are complete. A catalogue entry or a class inheriting unimplemented methods is not an integration.

## 5. Payment lifecycle and accounting

```text
CREATED -> ORDER_CREATED -> AWAITING_PROVIDER
  -> CAPTURED_UNPOSTED -> POSTED_TO_FOLIO

Timeout / unknown provider result -> RECONCILIATION_REQUIRED
Verified terminal decline -> FAILED
Immutable identity / amount / currency mismatch -> CONFLICT
```

1. Reserve an immutable intent and idempotency record against the canonical folio before provider dispatch.
2. The backend creates the provider order and persists provider references before returning checkout data.
3. The app opens the provider's supported hosted checkout / SDK flow. It never handles merchant secrets.
4. The app's result is a hint only. Backend status lookup and webhook processing both use provider-specific verification.
5. Verify provider, environment, merchant account, order/payment references, amount, currency and transaction identity.
6. A timeout after dispatch is ambiguous. Reconcile using original provider references before any retry that might create another charge.
7. A verified capture enters CAPTURED_UNPOSTED. The accounting coordinator posts exactly one payment ledger entry and one unique receipt against the canonical PMS folio.
8. If PMS accounting is in a separate database, use a transactional outbox and replay-safe saga; do not claim cross-database atomicity. Acknowledge device sync only after durable receipt read-back.
9. Refunds are separate immutable operations. Enforce cumulative pending + successful refunds against captured value. Do not post a PMS reversal until provider-confirmed refund success.

## 6. Offline behavior

Bookings, rooms, guest records, folio viewing, cash/manual UPI recording and core PMS functions remain available offline. Gateway order creation, payment verification, refunds and reconciliation require backend/provider connectivity. An offline gateway intent is not a payment and must never increase collected totals. Uncertain in-flight operations remain pending reconciliation and must not be re-dispatched as a new charge.

## 7. Live-collection release gates

Live collection remains OFF until all of the following are evidenced:

1. Production merchant account, KYC, contracting, permitted business category and settlement bank approval for each provider.
2. Provider-specific official API contract review and merchant sandbox/UAT certification.
3. Secret Manager IAM, workload identity, public HTTPS ingress, webhook signature validation and webhook replay/deduplication tests.
4. Native Capacitor bridge/client API is registered, authenticated, versioned and fails closed when unavailable.
5. Canonical PMS folio schema and accounting receipt are integrated; duplicate and concurrent events create one credit only.
6. Status polling, ambiguous timeout recovery, process death, duplicate webhooks, invalid signatures, amount/currency mismatch, clock skew and provider outage tests pass.
7. Refund and partial-refund lifecycle, refund reconciliation and PMS reversal posting pass for each supported provider.
8. Monitoring, alerting, audit retention, operational reconciliation queue, backup/restore and incident response are ready.
9. Android build, backend CI, security review and physical-device acceptance pass.
10. A signed release authorization explicitly enables a provider/environment. Default remains OFF. Disabling live collection blocks new live dispatches but does not erase or abandon already-dispatched transactions.

## 8. Current repository checkpoint

- Cloud runtime foundation exists in `payment-backend/src/server.mjs`, but deployment, IAM, public ingress and readiness have not been independently verified.
- Razorpay and Cashfree adapters exist but are partial. Refund-status lookup, durable webhook inbox/reconciliation and canonical folio settlement remain incomplete.
- PayU, PhonePe, Paytm, JioPay and CCAvenue remain unimplemented and are deliberately not registered as working adapters.
- An authenticated HTTPS client foundation now exists at `src/services/payment-api.mjs`. It injects a caller-supplied Firebase ID token, validates intent input, forwards stable idempotency keys and preserves ambiguous network failures as reconciliation-required errors. It is not yet wired into the app's sign-in/session lifecycle or payment UI.
- A dependency-ordered execution plan and client unit tests have been added. Test execution, Android build, cloud deployment, provider sandbox/UAT and physical-device acceptance have not yet been verified.

See [PAYMENT_IMPLEMENTATION_PLAN.md](./PAYMENT_IMPLEMENTATION_PLAN.md) for phase gates and next implementation actions. Live collection remains OFF.
