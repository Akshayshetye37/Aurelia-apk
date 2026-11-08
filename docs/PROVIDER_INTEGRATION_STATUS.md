# Aurelia PMS — Seven-provider integration status

**Architecture:** Hybrid production backend. Android remains the offline-first PMS client; the cloud backend owns provider credentials, payment verification and accounting orchestration.  
**Working branch:** `feature/multi-provider-payment-backend`  
**Release status:** Live payment collection is OFF. No provider is production-ready. The factory can instantiate six complete seven-operation adapters; the cloud payment-intent/API routes still expose only Razorpay and Cashfree.

| Provider | Adapter/factory state | Cloud checkout API enabled | Remaining gates |
|---|---|---:|---|
| Razorpay | Implemented; seven-operation contract; factory-wired | Yes, test checkout only | Verify provider contract tests, webhook replay/concurrency, refund idempotency/status, canonical folio posting, Android integration and sandbox UAT |
| Cashfree | Implemented; seven-operation contract; factory-wired | Yes, test checkout only | Verify current API/webhook/refund contracts, provider contract tests, replay/concurrency, canonical folio posting, Android integration and sandbox UAT |
| PayU | Classic hosted checkout, payment verification, reverse-hash webhook and refund lifecycle implemented; factory-wired | No | Cloud checkout, webhook and recovery route qualification; merchant sandbox/UAT; canonical folio posting; physical-device acceptance |
| PhonePe | Standard Checkout V2 OAuth, checkout, status, SHA256 webhook auth and refund lifecycle implemented; factory-wired | No | Integrate cloud routes and verify merchant-specific API version, webhook configuration, refund status, sandbox/UAT and physical-device acceptance |
| Paytm | Official checksum-based initiate, status, callback and refund lifecycle implemented; factory-wired | No | Integrate cloud routes; verify merchant MID/website config, staging/UAT, callback and refund reconciliation |
| JioPay | Hosted checkout, HMAC-SHA256, status, webhook and refund command lifecycle implemented; factory-wired | No | Confirm merchant/aggregator configuration, UAT status/refund responses, cloud routes and device acceptance |
| CCAvenue | Catalogue-only; deliberately not wired | No | Obtain current merchant-specific integration kit and authoritative checkout/status/standard-refund contracts; implement and test before factory registration |

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

- The provider factory wires Razorpay, Cashfree, PayU, PhonePe, Paytm and JioPay after all seven adapter operations pass capability checks. The registry is the source of truth for cloud checkout exposure: only Razorpay and Cashfree are enabled. The intent creation, sandbox test-order, webhook ingress and provider activation routes enforce this allowlist. PayU, PhonePe, Paytm and JioPay remain adapter-only; credential onboarding/validation does not grant checkout access. `providerQualificationStatus()` now reports `cloudCheckoutApiEnabled` and `testCheckout` from the registry rather than assuming every factory-wired adapter is exposed. CCAvenue remains catalogue-only because current merchant-specific checkout/status/refund contracts have not been verified.
- The reconciliation endpoint is authenticated and batch-bounded, but currently invokes a manual sweep; it is not a scheduled service.
- The worker and settlement helper still target `paymentFolios/{tenant+folio hash}` and `journalEntries/{intentId}`. The repository has not established that this matches the canonical deployed PMS schema.
- Firestore indexes must be deployed with the backend. Concurrency, lease recovery and production query load remain to be verified.
- Unit/contract tests and backend CI cover the six factory-wired adapters. These tests use deterministic mock provider responses; they are not merchant sandbox/UAT evidence. No provider-specific live merchant UAT, cloud deployment, physical-device acceptance or live collection is asserted.
