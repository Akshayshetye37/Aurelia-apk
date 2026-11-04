# Aurelia PMS — Seven-provider integration status

**Architecture:** Hybrid production backend. Android remains the offline-first PMS client; the cloud backend owns provider credentials, payment verification and accounting orchestration.  
**Active provider implementation branch:** `feature/payment-provider-production-adapters`  
**Parent review branch:** `fix/phase-1-accounting-audit`  
**Development/base branch:** `feature/multi-provider-payment-backend`  
**Release status:** Live payment collection is OFF. No provider is production-ready.

| Provider | Code state | Catalogue/API visibility | Executable factory / checkout | Remaining gates |
|---|---|---:|---:|---|
| Razorpay | Adapter exists; lifecycle partial | Yes | Yes, restricted test checkout | Contract tests, refund lifecycle, atomic PMS ledger integration, reconciliation, Android and sandbox UAT |
| Cashfree | Adapter exists; lifecycle partial | Yes | Yes, restricted test checkout | Contract tests, refund lifecycle, atomic PMS ledger integration, reconciliation, Android and sandbox UAT |
| PayU | Prototype source exists; refund methods fail closed | Yes, explicitly marked prototype | No | Confirm exact merchant v2 contract, complete refund/status, correct callback verification, route wiring, tests and sandbox UAT |
| PhonePe | PG V2 prototype source exists; not qualified | Yes, explicitly marked prototype | No | Confirm merchant PG V2 account/API version, token lifecycle, callback authentication, refund identity/status, route wiring, tests and sandbox UAT |
| Paytm | Not implemented | Yes, marked not implemented | No | Obtain current merchant PG documentation and sandbox; implement and qualify complete lifecycle |
| JioPay | Hosted-checkout module added from public docs; not yet wired or merchant-UAT-qualified | Yes, marked prototype | No | Confirm merchant-specific field/hash rules and command response signatures with JPSL; add complete contract/route tests and pass sandbox UAT |
| CCAvenue | Not implemented; merchant integration kit unavailable | Yes, marked integration kit required | No | Obtain merchant integration kit, confirm API version/crypto test vectors and sandbox |

The backend catalogue lists all seven providers for visibility. This is deliberately separate from the executable provider factory and credential/checkout allowlists, which remain restricted to Razorpay and Cashfree. PayU and PhonePe prototypes are also not registered. JioPay's module is not registered or reachable from server routes. Paytm and CCAvenue have no adapter source. No non-reference provider can be configured, activated or used for checkout through the cloud backend.
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

- The backend currently enables only Razorpay and Cashfree routes. PayU and PhonePe source files are prototypes, and JioPay is an unregistered module; none is an end-to-end integration.
- The reconciliation endpoint is authenticated and batch-bounded, but currently invokes a manual sweep; it is not a scheduled service.
- The worker and settlement helper still target `paymentFolios/{tenant+folio hash}` and `journalEntries/{intentId}`. The repository has not established that this matches the canonical deployed PMS schema.
- Firestore indexes must be deployed with the backend. Concurrency, lease recovery and production query load remain to be verified.
- No automated test pass, cloud deployment, provider sandbox/UAT, Android build or physical-device acceptance is asserted until CI/runtime evidence exists.

## Official provider documentation reviewed

- **Paytm:** [Initiate Transaction API](https://www.paytmpayments.com/docs/api/initiate-transaction-api), [Transaction Status API](https://www.paytmpayments.com/docs/api/v3/transaction-status-api), [Refund API](https://www.paytmpayments.com/docs/api/refund-api), [Refund Status API](https://www.paytmpayments.com/docs/api/refund-status-api). Official docs specify a signed JSON request envelope, txnToken, status lookup and asynchronous refund lifecycle. Do not use the unverified HMAC shortcut from the initial proposal.
- **JioPay / JPSL:** [Hosted checkout integration](https://docs.jiopay.in/docs/integration-steps), [Hash generation](https://docs.jiopay.in/docs/generate-hash), [Callbacks](https://docs.jiopay.in/docs/webhooks), [Status check](https://docs.jiopay.in/docs/status-check), [STATUS / REFUND API](https://docs.jiopay.in/reference/command). The docs specify HMAC-SHA256 over concatenated values in alphabetically sorted key order, initiateSale endpoints, S2S callbacks, and a command endpoint for status/refund.
- **PhonePe:** [PG V2 Standard Checkout](https://developer.phonepe.com/phonepe-payment-gateway/pg-v2-standard-checkout-integration), [OAuth authorization](https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/api-integration/api-reference/authorization), [Initiate Payment](https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/api-integration/api-reference/create-payment/initiate-payment), [Order Status](https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/api-integration/api-reference/order-status), [Refund](https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/api-integration/api-reference/refund), [Webhook Handling](https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/api-integration/api-reference/webhook). Current PG V2 uses OAuth O-Bearer, checkout v2 endpoints, status and refund endpoints. PhonePe requires UAT sign-off before production credentials/go-live.
- **PayU:** [Official developer docs](https://docs.payu.in/), [v2 API reference](https://docs.payu.in/v2/reference/introduction-api-reference). The selected integration version must be fixed before adapter work; v2 and legacy _payment/post-service APIs use different authentication and request contracts.
- **CCAvenue:** [Official technical FAQ](https://www.ccavenue.com/faq). Publicly accessible material reviewed here is insufficient to safely pin down the current merchant API endpoint set, exact request/response envelope, encryption test vectors and refund/status lifecycle. Require the merchant-specific integration kit and confirm the applicable API version before implementing cryptography.

Official public docs establish protocol shape, not Aurelia merchant enablement, account approval, UAT success or production readiness.