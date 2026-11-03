# Aurelia PMS — Payment implementation execution plan

**Branch:** `feature/multi-provider-payment-backend`  
**Architecture:** Hybrid — Android is an offline-first client; the cloud backend is the payment authority.  
**Release posture:** Live collection stays disabled. No provider is production-ready until its complete acceptance evidence exists.

## Strategic sequencing

This work is dependency-ordered, not seven parallel adapter projects. The first two providers become the reference implementations and establish the contract every later provider must satisfy. New providers are not exposed as working integrations merely because a class or catalogue row exists.

| Phase | Workstream | Deliverables | Exit evidence | Current state |
|---|---|---|---|---|
| 0 | Cloud runtime hardening | Cloud Run runtime, readiness, IAM/Secret Manager, HTTPS ingress, CI | Cloud deploy smoke test, least-privilege review, readyz and webhook reachability | Foundation committed; deployment not verified |
| 1 | Authenticated Android API client | HTTPS-only client, Firebase ID-token injection, typed errors, idempotency, timeout ambiguity behavior | Unit tests; app authentication integration; Android build | Client foundation added; app wiring remains |
| 2 | Razorpay + Cashfree reference lifecycle | Order dispatch, verified callbacks, status reconciliation, refund status, durable event dedupe | Provider contract tests and merchant sandbox/UAT evidence | Existing adapters partial; lifecycle incomplete |
| 3 | Five independent provider adapters | PayU, PhonePe, Paytm, JioPay, CCAvenue each with their own auth, signing, status, webhook and refund behavior | Separate adapter + schema + contract tests + sandbox evidence per provider | Not started; not advertised as available |
| 4 | Financial event and accounting pipeline | Webhook ingress, replay-safe inbox, authoritative provider lookup, refund workflow, reconciliation queue, transactional outbox, canonical folio posting | Duplicate/concurrent delivery tests; ledger invariants; recovery drills | Not complete |
| 5 | End-to-end release qualification | Android lifecycle/process-death, offline/online transitions, network faults, provider outages, UAT and operational runbooks | Signed acceptance per provider/environment; explicit release authorization | Not started |

## Execution rules

1. **Do not implement all five missing providers in one generic adapter.** Their signing algorithms, token acquisition, callback semantics, status APIs and refund contracts differ. Share only the Aurelia-facing interface and transport/security utilities.
2. **Finish reference implementations first.** Razorpay and Cashfree must pass the same lifecycle contract, including refund-status lookup and failure recovery, before their patterns are copied.
3. **Keep capability state evidence-based.** Distinguish `DOCUMENTATION_ONLY`, `ADAPTER_IN_PROGRESS`, `SANDBOX_VERIFIED` and `LIVE_ELIGIBLE`. Only backend-confirmed capabilities may be shown to the client.
4. **Never retry an ambiguous create-order request with a new key.** Persist the original idempotency key and provider reference; reconcile before another dispatch.
5. **No client-side settlement.** SDK callbacks and redirects are hints. Only verified provider state can enter the accounting pipeline.
6. **No live switch by configuration alone.** Merchant approval, UAT, security review, reconciliation, refund and folio evidence plus signed release authorization are required.

## Provider-specific implementation gates

| Provider | Product/API decision required before coding | Minimum adapter contract |
|---|---|---|
| Razorpay | Confirm Orders + Payments APIs and enabled refund model | credentials validation, order create/find, payment lookup, raw-body webhook verification, refund create/status |
| Cashfree | Confirm current PG API version and webhook version | credentials validation, order create/find, payment lookup, raw-body webhook verification, refund create/status |
| PayU | Select India Hosted Checkout or supported S2S product and exact API version | hash generation/verification, verify-payment, webhook, refund create/status |
| PhonePe | Confirm merchant Standard Checkout product and current API version | token lifecycle, order create/status, callback verification, refund create/status |
| Paytm | Confirm merchant PG product and staging contract | checksum/signature, initiate/status, callback verification, refund create/status |
| JioPay | Obtain merchant-specific API pack and enabled product | secureHash, initiation, status/refund command, callback verification |
| CCAvenue | Obtain merchant-specific integration kit and enabled API version | request encryption, response decryption, status/refund workflow, callback validation |

## Current implementation checkpoint

- The cloud backend is a Firebase Admin + Firestore + Secret Manager prototype, not a verified production deployment.
- The existing Razorpay and Cashfree adapters expose partial operations. The repository currently does not complete refund-status, durable reconciliation, verified webhook-to-folio settlement, or production acceptance.
- Five additional provider adapters remain intentionally absent.
- The Android client API wrapper is a reusable foundation only; it is not yet wired into the app's sign-in/session lifecycle or payment UI.
- No cloud deployment, provider sandbox/UAT, Android build, or physical-device acceptance is claimed by this plan.

## Immediate next actions

1. Wire `PaymentApiClient` to the app's actual Firebase authentication/session provider and environment configuration.
2. Add a durable webhook inbox with provider/environment-scoped event deduplication and authoritative status lookup.
3. Extend the provider contract with refund-status and order-reference lookup; complete Razorpay and Cashfree tests.
4. Only then start PayU as the first new adapter, followed by PhonePe, Paytm, JioPay and CCAvenue as independent workstreams.
