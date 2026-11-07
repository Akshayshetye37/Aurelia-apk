# Aurelia PMS — Seven-provider integration status

**Architecture:** Hybrid production backend. Android remains the offline-first PMS client; the cloud backend owns provider credentials, payment verification and accounting orchestration.  
**Working branch:** `feature/phase-7-pms-persistence` (base: `feature/multi-provider-payment-backend`)  
**Release status:** Live payment collection is OFF. No provider is production-ready. Six complete seven-operation adapters are factory-wired and exposed through the cloud checkout/onboarding/webhook/status/refund API surface. Android checkout handoff remains limited to Razorpay and Cashfree.

| Provider | Adapter/factory | Cloud backend routes | Android checkout handoff | End-to-end / production ready |
|---|---|---:|---:|---:|
| Razorpay | Seven lifecycle operations; wired | Yes — test path; live blocked | Yes | **No** — merchant UAT, canonical folio posting, device acceptance and release gates open |
| Cashfree | Seven lifecycle operations; wired | Yes — test path; live blocked | Yes | **No** — merchant UAT, canonical folio posting, device acceptance and release gates open |
| PayU | Classic hosted checkout, status, reverse-hash webhook and refund lifecycle; wired | Yes — test path; live blocked | No | **No** — credential validation is format-only; merchant UAT, route/device acceptance and folio posting open |
| PhonePe | Standard Checkout V2 OAuth, status, webhook auth and refund lifecycle; wired | Yes — test path; live blocked | No | **No** — merchant UAT, route/device acceptance and folio posting open |
| Paytm | Checksum-based initiate, status, callback and refund lifecycle; wired | Yes — test path; live blocked | No | **No** — staging/UAT, merchant config, device acceptance and folio posting open |
| JioPay | Hosted checkout, HMAC-SHA256, status, webhook and refund command lifecycle; wired | Yes — test path; live blocked | No | **No** — merchant/aggregator UAT, device acceptance and folio posting open |
| CCAvenue | Catalogue-only; no concrete adapter/factory | No | No | **No** — obtain merchant integration kit, implement and test before registration |

**Count:** six backend adapters/cloud API integrations; two Android checkout handoffs; one catalogue-only provider; zero production-qualified gateways. Cloud adapter refund endpoints do not mean refund-to-folio posting is enabled.

## Dependency-ordered delivery sequence

1. **Freeze the financial domain contract.** Inspect the real PMS reservation, folio, currency, balance, journal and version/concurrency model. Map it explicitly to payment intents. Do not create a parallel authoritative ledger or migrate records by assumption.
2. **Harden the payment core.** Define state transitions, idempotency, order identity, immutable provider evidence, webhook inbox and outbox semantics. Add race, duplicate, timeout and process-restart tests.
3. **Complete the reference providers.** Make Razorpay and Cashfree pass one shared adapter contract, including authoritative status, raw-body webhook verification, refund creation and refund status. Keep test/live environment separation strict.
4. **Complete accounting and recovery.** Post capture/refund entries atomically to the confirmed PMS folio schema; implement bounded reconciliation, lease/claim semantics, retry policy, observability and operator controls.
5. **Integrate the app.** Wire the HTTPS client to the actual Firebase session provider, derive provider UI from backend capabilities, handle pending/unknown states, and test Android lifecycle/offline recovery.
6. **Add providers independently.** Implement PayU, PhonePe, Paytm, JioPay and CCAvenue one at a time, each with product-version confirmation, adapter contract tests and merchant sandbox evidence.
7. **Qualify and release.** Complete security review, deployment/IAM, webhook reachability, UAT, refund/reconciliation drills, operational runbooks and signed release authorization. Live collection remains blocked until every gate is evidenced.

## Architecture invariants

- Merchant secrets exist only in managed backend secret storage; never in HTML, JavaScript, local storage or the APK.
- Tenant identity is derived from verified authentication and server-side membership, never trusted from request payloads.
- Client redirects and SDK callbacks are untrusted signals; only provider-side status verification establishes capture.
- A captured payment is not settled until the canonical PMS journal entry and folio balance update commit atomically.
- One stable idempotency identity is retained across retries. An ambiguous provider request is reconciled before another create-order call.
- Webhook delivery, provider polling and manual recovery must converge on one idempotent settlement operation.
- Refunds are separate financial events; refund requested is not refund completed.
- Provider capability labels are computed from completed server-side capabilities and acceptance evidence, not adapter class existence.
- Live collection is disabled in code until accounting, refunds, reconciliation, security and operational acceptance are complete.

## Current evidence and limitations

- The provider factory wires Razorpay, Cashfree, PayU, PhonePe, Paytm and JioPay after all seven adapter operations pass capability checks. The cloud server's provider catalogue, tenant-scoped credential onboarding/validation, test-order creation, webhook verification, authoritative status lookup and refund request/status endpoints accept all six factory-wired providers. The public Android checkout handoff remains limited to Razorpay and Cashfree. CCAvenue remains catalogue-only because a complete merchant-specific checkout/status/refund contract has not been supplied.
- The reconciliation endpoint is authenticated and batch-bounded, but currently invokes a manual sweep; it is not a scheduled service.
- The worker and settlement helper still target `paymentFolios/{tenant+folio hash}` and `journalEntries/{intentId}`. The repository has not established that this matches the canonical deployed PMS schema.
- Firestore indexes must be deployed with the backend. Concurrency, lease recovery and production query load remain to be verified.
- The repository contains deterministic mock-based contract tests for all six factory-wired adapters. These tests are not merchant sandbox/UAT evidence. PayU's current validateCredentials implementation performs format checks only and must not be interpreted as remote merchant credential authentication. No provider-specific live merchant UAT, cloud deployment, physical-device acceptance or live collection is asserted.
