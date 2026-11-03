# Aurelia PMS — Payment execution and release specification

**Architecture:** Hybrid Production Architecture (Architecture A).  
**Authority:** [HYBRID_PAYMENT_ARCHITECTURE.md](./HYBRID_PAYMENT_ARCHITECTURE.md).  
**Status:** Implementation in progress; live collection OFF.

This specification supersedes all earlier device-local payment execution instructions. Android is an offline-first PMS client, not a payment authority. The trusted public HTTPS backend owns provider credentials, provider API calls, webhook ingress, authoritative status verification, refund operations, reconciliation and the payment-to-folio coordinator.

## 1. Trust boundaries

| Layer | Owns | Must not do |
|---|---|---|
| Android / Capacitor | PMS UI, offline PMS database, authenticated backend requests, checkout presentation, local pending display | Store merchant API secrets; assert payment success; create provider orders directly; post folio credits |
| Hybrid backend | Tenant/role authorization, secret retrieval, provider adapters, order creation, verification, webhooks, refund/reconciliation orchestration | Trust client callback as proof; expose secret material |
| Secret Manager | Merchant API keys, salts, webhook secrets, provider signing credentials | Be readable by mobile clients or broad project principals |
| Durable payment store | Intents, provider refs, idempotency, webhook inbox, refund state, audit and outbox | Overwrite immutable transaction identity or drop ambiguous states |
| Canonical PMS accounting | Folio ledger entry, unique posting receipt, durable acknowledgement | Double-credit or post without verified capture |

Use workload identity / Application Default Credentials. Do not ship service-account JSON keys. Enforce TLS, strict request schemas, tenant/property isolation, least-privilege IAM, redacted logs, rate limits and auditable secret rotation.

## 2. Provider capability contract

Each provider adapter must independently implement the operations it advertises:

- Validate credentials with a read-only provider request.
- Create or retrieve an order using a stable Aurelia idempotency identity.
- Open only the provider-approved hosted checkout / SDK using public checkout data.
- Fetch authoritative payment status by exact provider order/payment reference.
- Verify webhook signatures using exact raw bytes and environment-specific secrets.
- Deduplicate webhook event IDs and reject event-ID/payload-hash conflicts.
- Create full/partial refunds with a separate idempotency key.
- Fetch refund status and reconcile ambiguous refund submissions.

The common interface does not imply common cryptography or request formats. PayU hashes, PhonePe authentication, Paytm checksums, JioPay secureHash and CCAvenue encryption must be implemented according to each selected merchant product and current official API version.

## 3. Payment lifecycle

```text
CREATED -> ORDER_CREATED -> AWAITING_PROVIDER
  -> CAPTURED_UNPOSTED -> POSTED_TO_FOLIO

Unknown outcome / timeout -> RECONCILIATION_REQUIRED
Verified terminal decline -> FAILED
Immutable identity / amount / currency mismatch -> CONFLICT
```

1. Reserve the payment intent against the canonical open folio before provider dispatch.
2. Use a stable idempotency key and persist the immutable request fingerprint.
3. Backend creates the provider order and persists provider references before returning checkout data.
4. Client callback/redirect is only a hint. Backend verifies using provider status APIs and authenticated webhook evidence.
5. Verify provider, environment, merchant account, order/payment IDs, amount in integer minor units and currency.
6. Timeout after dispatch is ambiguous. Reconcile original references before retrying a charge-creating operation.
7. A verified capture becomes CAPTURED_UNPOSTED. It is not yet a folio credit.
8. Post one payment ledger entry and one unique receipt through the canonical accounting boundary. If payment state and PMS accounting are in separate databases, use a transactional outbox and replay-safe saga; do not claim cross-database atomicity.
9. Read back the durable receipt before acknowledging device sync or displaying the folio as settled.

## 4. Refund lifecycle

A refund is a separate immutable operation. Persist refund ID, original transaction ID, idempotency key, amount minor units, provider refund reference, state, timestamps and evidence. Enforce cumulative successful plus pending refunds not exceeding captured amount. A timeout after refund dispatch is ambiguous; query refund status before resubmission. Post the PMS reversal only after provider-confirmed refund success. Disable refunds for adapters that have not passed contract tests.

## 5. Offline behavior

Bookings, rooms, guest records, folio viewing, invoices, reports and cash/manual UPI recording remain available offline. Gateway order creation, payment verification, refunds and reconciliation require backend/provider connectivity. An offline intent is not a payment and must never increase collected totals. Keep in-flight ambiguous transactions visible for later reconciliation; never convert them to failure or create a replacement charge merely because the app was closed.

## 6. Live collection master switch

Live collection is OFF by default and enforced by the backend, not by a WebView toggle. A provider/environment can be enabled only after signed release authorization confirms all applicable gates. Turning OFF blocks new live dispatches but does not erase, cancel or relabel transactions already dispatched; those transactions must still be reconciled.

### Mandatory release gates

1. Merchant KYC, contracting, permitted business category, settlement account and production API access confirmed for each provider.
2. Current official API/product version and provider-specific signing/authentication reviewed.
3. Server-side secret custody, workload identity, Secret Manager IAM, HTTPS ingress and webhook signature/replay controls reviewed.
4. Native/Capacitor client transport, authentication and device sync are registered and fail closed.
5. Provider sandbox/UAT tests pass for order creation, success, failure, pending, duplicate events, invalid signatures and amount/currency/reference mismatch.
6. Status polling, timeout recovery, process death, provider outage and duplicate/concurrent request tests pass.
7. Full/partial refunds and refund reconciliation pass for each adapter that advertises refund support.
8. Capture-to-folio posting and refund reversal use the canonical PMS accounting schema with durable idempotency receipts.
9. Monitoring, audit retention, reconciliation queue, backup/restore and incident response are operational.
10. Android build, backend CI, security review and physical-device acceptance pass.
11. A signed release authorization enables only the approved provider/environment. Live collection remains OFF otherwise.

## 7. Current repository status

See [PROVIDER_INTEGRATION_STATUS.md](./PROVIDER_INTEGRATION_STATUS.md) for the seven-provider matrix. At the current checkpoint, Razorpay and Cashfree backend adapters exist in the legacy/cloud code paths, but the selected hybrid backend and mobile client are not yet production-complete. PayU, PhonePe, Paytm, JioPay and CCAvenue server adapters are not present. No provider is approved for live collection.

**Do not enable live collection or represent this branch as production-ready until all applicable gates above are evidenced.**
