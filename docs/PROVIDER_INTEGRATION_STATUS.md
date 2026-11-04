# Aurelia PMS — Seven-provider integration status

**Architecture:** Hybrid production backend. Android remains the offline-first PMS client; the cloud backend owns provider credentials, payment verification and accounting orchestration.  
**Working branch:** `feature/multi-provider-payment-backend`  
**Release status:** Live payment collection is OFF. No provider is production-ready.

| Provider | Code state | Exposed by production factory/API | Remaining gates |
|---|---|---:|---|
| Razorpay | Adapter implemented; partial lifecycle | Yes, test checkout only | Verify provider contract tests, webhook replay/concurrency, refund idempotency/status, canonical folio posting, Android integration and sandbox UAT |
| Cashfree | Adapter implemented; partial lifecycle | Yes, test checkout only | Verify current API/webhook/refund contracts, provider contract tests, replay/concurrency, canonical folio posting, Android integration and sandbox UAT |
| PayU | Incomplete prototype; refund/status lifecycle disabled | No | Confirm exact PayU product/API contract, credential semantics, reverse-hash contract, refund APIs, server routing, adapter tests and sandbox UAT |
| PhonePe | Incomplete prototype; not registered; webhook/refund semantics unqualified | No | Confirm exact PhonePe merchant product/version, OAuth, order/status/refund idempotency, callback authentication, server routing, adapter tests and sandbox UAT |
| Paytm | Not implemented | No | Confirm merchant PG product, obtain current API contract, implement and test complete lifecycle |
| JioPay | Documentation/scaffold only | No | Obtain merchant API pack, implement and test complete lifecycle |
| CCAvenue | Not implemented | No | Obtain merchant integration kit/API version, implement and test complete lifecycle |

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

- The backend enables only Razorpay and Cashfree adapters. PayU and PhonePe prototypes are deliberately excluded: PayU's refund lifecycle is explicitly disabled and PhonePe's callback/refund contracts are not accepted as complete. Paytm, JioPay and CCAvenue remain catalogue-only.
- The reconciliation endpoint is authenticated and batch-bounded, but currently invokes a manual sweep; it is not a scheduled service.
- The worker and settlement helper still target `paymentFolios/{tenant+folio hash}` and `journalEntries/{intentId}`. The repository has not established that this matches the canonical deployed PMS schema.
- Firestore indexes must be deployed with the backend. Concurrency, lease recovery and production query load remain to be verified.
- No automated test pass, cloud deployment, provider sandbox/UAT, Android build or physical-device acceptance is asserted until CI/runtime evidence exists.
