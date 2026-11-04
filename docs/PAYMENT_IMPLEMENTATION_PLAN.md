# Aurelia PMS — Payment implementation execution plan

**Branch:** `feature/multi-provider-payment-backend`  
**Architecture:** Hybrid — Android is an offline-first client; the cloud backend is the payment authority.  
**Release posture:** Live collection stays disabled. No provider is production-ready until its complete acceptance evidence exists.  
**Detailed engineering sequence:** [Implementation strategy](./IMPLEMENTATION_STRATEGY.md).

## Dependency-ordered phases

| Phase | Workstream | Deliverables | Exit evidence | Current state |
|---|---|---|---|---|
| 0 | Cloud runtime hardening | HTTPS ingress, readiness, IAM/Secret Manager, CI | Deployment smoke test, least-privilege review, readyz and webhook reachability | Foundation committed; deployment not verified |
| 1 | Financial domain contract | Canonical reservation/folio/journal mapping and concurrency/version semantics | Verified production schema and contract tests | **Blocking dependency**; current paymentFolios schema is not confirmed canonical |
| 2 | Payment core | Intent state machine, idempotency, provider identity, durable webhook inbox/outbox | Duplicate, race, timeout, restart and mismatch tests | Partial implementation |
| 3 | Reference providers | Complete Razorpay and Cashfree create/status/webhook/refund lifecycle | Adapter contract tests and merchant sandbox/UAT evidence | Partial; test checkout only; no live eligibility |
| 4 | Accounting and recovery | Atomic canonical folio posting, refund journal, durable worker claims/leases, retry/backoff | Ledger invariants, concurrency tests, recovery drills | Partial; manual bounded reconciliation endpoint exists; settlement schema unresolved |
| 5 | Android integration | Firebase session wiring, capability-driven provider UI, pending/unknown UX | App tests, Android build and physical-device lifecycle tests | Client foundation exists; full app wiring unverified |
| 6 | Additional providers | PayU, PhonePe, Paytm, JioPay, CCAvenue independently | Separate contract tests and sandbox/UAT evidence per provider | PayU/PhonePe prototypes exist but are excluded from production registry; others not implemented |
| 7 | Release qualification | Security, deployment, webhook reachability, UAT, runbooks and approval | Signed acceptance per provider/environment | Not started |

## Execution rules

1. **Do not guess the canonical PMS schema.** Inspect the actual reservation/folio/journal write paths and version semantics before changing settlement. The proposed `pms_reservations/{reservationId}/folios/{folioId}` path is not yet verified against production data.
2. **Do not implement five providers in one generic adapter.** Share the Aurelia-facing interface and safe transport utilities only; provider signing, callbacks, status and refunds remain provider-specific.
3. **Keep the registry truthful.** Only complete adapters with all required operations belong in the production factory. A method that exists but always throws is not a supported capability.
4. **Never retry an ambiguous create-order request with a new key.** Persist the original idempotency key and provider reference; reconcile before another dispatch.
5. **Webhook and polling must converge.** Both call one idempotent accounting service. A duplicate event is terminal only after the folio journal post is complete.
6. **No client-side settlement.** SDK callbacks and redirects are hints. Only provider-side status verification establishes capture.
7. **No live switch by configuration alone.** Merchant approval, UAT, security review, reconciliation, refund and folio evidence plus signed release authorization are required.

## Current implementation checkpoint

- Cloud backend: Firebase Admin + Firestore + Secret Manager prototype; no verified production deployment.
- Runtime provider routes: Razorpay and Cashfree only, test checkout path; neither is production-ready.
- PayU and PhonePe adapter prototypes are present but deliberately excluded from the provider registry until API/refund/callback contracts and end-to-end paths are complete.
- Paytm, JioPay and CCAvenue are not implemented.
- Authenticated bounded reconciliation route exists, but it is manually invoked and still writes through the unverified `paymentFolios` settlement model. It is not a scheduled durable worker with lease claims.
- The Android API wrapper is not yet proven wired to the app's actual Firebase sign-in/session lifecycle.
- No cloud deployment, provider sandbox/UAT, Android build or physical-device acceptance is claimed.

## Immediate next actions

1. Inspect the actual PMS reservation/folio/journal model and freeze its canonical contract.
2. Add concurrency/duplicate webhook and reconciliation tests; execute the full backend test suite and fix observed failures.
3. Complete Razorpay/Cashfree adapter contract and refund lifecycle against official merchant API contracts.
4. Implement lease-based scheduled reconciliation and observability.
5. Wire the API client to the real Firebase session provider and test Android lifecycle.
6. Start PayU only after its exact merchant API version and refund contract are confirmed.
