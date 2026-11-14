# Aurelia PMS — Seven-provider integration status

**Architecture:** Hybrid production backend. Android remains the offline-first PMS client; the cloud backend owns provider credentials, payment verification and accounting orchestration.  
**Working branch:** `feature/multi-provider-payment-backend`  
**Release status:** Live payment collection is OFF. No provider is production-ready. The factory can instantiate six complete seven-operation adapters plus a CCAvenue adapter for hosted checkout, status lookup and encrypted callbacks. Test checkout routes expose all seven providers; live collection remains disabled.

| Provider | Adapter/factory state | Cloud checkout API enabled | Remaining gates |
|---|---|---:|---|
| Razorpay | Implemented; seven-operation contract; factory-wired | Yes, test checkout only | Verify provider contract tests, webhook replay/concurrency, refund idempotency/status, canonical folio posting, Android integration and sandbox UAT |
| Cashfree | Implemented; seven-operation contract; factory-wired | Yes, test checkout only | Verify current API/webhook/refund contracts, provider contract tests, replay/concurrency, canonical folio posting, Android integration and sandbox UAT |
| PayU | Classic hosted checkout, payment verification, reverse-hash webhook and refund lifecycle implemented; factory-wired | Yes, test only | Merchant sandbox/UAT; canonical folio posting; physical-device acceptance |
| PhonePe | Standard Checkout V2 OAuth, checkout, status, SHA256 webhook auth and refund lifecycle implemented; factory-wired | Yes, test only | Verify merchant-specific API version, webhook configuration, refund status, sandbox/UAT and physical-device acceptance |
| Paytm | Official checksum-based initiate, status, callback and refund lifecycle implemented; factory-wired | Yes, test only | Verify merchant MID/website config, staging/UAT, callback and refund reconciliation |
| JioPay | Hosted checkout, HMAC-SHA256, status, webhook and refund command lifecycle implemented; factory-wired | Yes, test only | Confirm merchant/aggregator configuration, UAT status/refund responses and device acceptance |
| CCAvenue | Hosted checkout + encrypted callback + order-status API factory-wired; refund API partial (split-refund only) | Yes, test route only | Merchant IP allowlisting, merchant-specific API-key validation, callback/UAT evidence, standard refund API confirmation; live collection remains disabled |

## Dependency-ordered delivery sequence

1. **Freeze the financial domain contract.** Inspect the real PMS reservation, folio, currency, balance, journal and version/concurrency model. Map it explicitly to payment intents. Do not create a parallel authoritative ledger or migrate records by assumption.
2. **Harden the payment core.** Define state transitions, idempotency, order identity, immutable provider evidence, webhook inbox and outbox semantics. Add race, duplicate, timeout and process-restart tests.
3. **Complete the reference providers.** Make Razorpay and Cashfree pass one shared adapter contract, including authoritative status, raw-body webhook verification, refund creation and refund status. Keep test/live environment separation strict.
4. **Complete accounting and recovery.** Post capture/refund entries atomically to the confirmed PMS folio schema; implement bounded reconciliation, lease/claim semantics, retry policy, observability and operator controls.
5. **Integrate the app.** Wire the HTTPS client to the actual Firebase session provider, derive provider UI from backend capabilities, handle pending/unknown states, and test Android lifecycle/offline recovery.
6. **Add providers independently.** Implement PayU, PhonePe, Paytm, JioPay and CCAvenue one at a time, each with product-version confirmation, adapter contract tests and merchant sandbox evidence.
7. **Qualify and release.** Complete security review, deployment/IAM, webhook reachability, UAT, refund/reconciliation drills, operational runbooks and signed release authorization. Live collection remains blocked until every gate is evidenced.


## Seven-provider merchant acceptance programme

The executable evidence contract is `payment-backend/src/qualification/provider-acceptance.mjs`, with regression tests in `payment-backend/test/provider-acceptance.test.mjs`. It defines provider-specific test environments and scenario IDs, rejects missing/duplicate/failed/stale/malformed evidence, enforces complete seven-operation capability coverage and always returns `liveCollectionAuthorized: false`.

The full execution procedure, common scenario suite, provider-specific security tests, evidence schema, production gates and official documentation entry points are in [Seven-provider Merchant Acceptance](./SEVEN_PROVIDER_ACCEPTANCE.md).

**Important boundary:** this is an evidence validation primitive, not yet a persistent Firestore acceptance register or independent sign-off workflow. Its unit tests use synthetic evidence to verify the evaluator; they are not provider sandbox transactions. The six full-lifecycle adapters can qualify only after merchant UAT evidence. CCAvenue remains blocked because ordinary refund creation and authoritative refund-status operations are not implemented. No provider has merchant acceptance, production eligibility or live authorization at this time.

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

- The provider factory wires Razorpay, Cashfree, PayU, PhonePe, Paytm and JioPay with seven lifecycle operations, and CCAvenue with five documented checkout/status/callback operations. The registry is the source of truth for cloud checkout exposure: all seven providers are enabled for test-mode cloud checkout, sandbox test-order creation, webhook ingress and provider activation. The server enforces this allowlist at each execution route. Live collection remains disabled for all providers. `providerQualificationStatus()` now reports `cloudCheckoutApiEnabled` and `testCheckout` from the registry rather than assuming every factory-wired adapter is exposed. CCAvenue now has a factory-wired AES-encrypted hosted-checkout adapter, encrypted return-response parser, Dynamic Event Notification trigger parser and documented orderStatusTracker API. Dynamic events are not trusted as payment proof: the backend performs a fresh encrypted Status API lookup before accepting capture evidence. The merchant must register the deployed backend webhook URL in M.A.R.S Dynamic Event Notifications. The published API v1.3 only documents splitRefund for split-payout transactions; ordinary refunds and refund-status polling are not advertised as supported by this adapter. The CCAvenue cloud route is test-only; live collection remains disabled. Merchant public egress IP must be registered with CCAvenue before API status calls can pass.
- The reconciliation endpoint is authenticated and batch-bounded, but currently invokes a manual sweep; it is not a scheduled service.
- The worker and settlement helper still target `paymentFolios/{tenant+folio hash}` and `journalEntries/{intentId}`. The repository has not established that this matches the canonical deployed PMS schema.
- Firestore indexes must be deployed with the backend. Concurrency, lease recovery and production query load remain to be verified.
- Unit/contract tests cover the six complete lifecycle adapters and the five-operation CCAvenue adapter. These tests use deterministic mock provider responses; they are not merchant sandbox/UAT evidence. No provider-specific live merchant UAT, cloud deployment, physical-device acceptance or live collection is asserted.
