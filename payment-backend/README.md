# Aurelia Payment Backend

**Repository:** `Akshayshetye37/Aurelia-apk`  
**Branch:** `feature/multi-provider-payment-backend`  
**Path:** `payment-backend/`  
**Deployment status:** Not deployed.  
**Payment acceptance status:** Not production-ready; live payments must remain disabled.

This is a separately deployable Node.js service for Aurelia PMS payments. It is not part of the PMS APK or the Aurelia Pay Bridge APK. The backend contains provider adapters, security foundations, a payment-intent state machine, and an atomic Firestore reservation repository. These components are not yet connected into a complete customer checkout-to-folio-settlement flow.

## 1. Architecture and trust boundaries

- Firebase ID tokens are verified server-side, including revoked-token checking, verified email, MFA second-factor claim and recent authentication.
- Tenant identity is resolved from the trusted Firestore membership document `paymentMemberships/{firebaseUid}`; a client-supplied tenant ID is never an authorization source.
- Existing provider administration authorization requires an active membership with `owner` or `admin` role. The intent repository currently has a broader role allowlist (`owner`, `admin`, `staff`); this policy mismatch must be resolved before exposing an intent route.
- Provider credentials and webhook secrets belong in Google Secret Manager. No merchant secret may be embedded in the PMS APK, Pay Bridge APK, browser code or client configuration.
- Webhook tenant/order identifiers are lookup hints only. Resolve a pre-existing trusted provider-order binding, verify the raw-body signature, and independently fetch provider status before accepting a payment outcome.
- The service enforces HTTPS using Express `req.secure`. It trusts one ingress proxy only when explicitly configured. TLS protocol/cipher policy belongs at the hosting ingress; do not expose the container around that ingress.
- Firestore membership and payment authority collections must not be writable by mobile clients. Enforce this with Firestore Security Rules and IAM.

## 2. Implemented foundations

### Provider adapters

- `src/providers/razorpay.mjs`: credential validation, INR order creation using paise, server-side order/payment lookup, raw-body HMAC webhook verification and refund creation.
- `src/providers/cashfree.mjs`: credential validation, hosted checkout session creation, server-side order/payment lookup, timestamp plus raw-body webhook signature verification and refund creation.
- `src/providers/adapter-contract.mjs`: common adapter interface and capability checks.
- `src/providers/factory.mjs`: factory for the implemented Razorpay and Cashfree adapters; unsupported providers fail closed.
- `src/providers/registry.mjs`: provider implementation/capability status. PayU, PhonePe, Paytm, CCAvenue and JioPay are not implemented.

These adapter modules have deterministic unit/contract tests. They have not completed merchant sandbox end-to-end verification and are not yet wired into the full payment-intent service.

### Payment domain and state machine

- `src/payment-domain.mjs`: integer minor-unit validation, INR handling, provider/tenant/environment/order/amount/currency binding and conservative status normalization.
- `src/intents/intent-state-machine.mjs`: canonical states `DISPATCHING`, `CREATED`, `PENDING`, `AUTHORIZED`, `UNKNOWN`, `CAPTURED`, `FAILED_TO_INITIATE` and `FAILED`.
- Client callbacks and unverified webhook payloads are not authoritative payment evidence.
- `UNKNOWN` is deliberately non-terminal. It must remain reserved until an authoritative provider lookup resolves the outcome.
- A late verified capture may supersede a previously reported failure. A captured intent must not regress.

### Firestore intent reservation repository

- `src/intents/firestore-repository.mjs` creates durable payment intent reservations using deterministic Firestore documents:
  - `paymentIntentIdempotency/{hash}`
  - `paymentFolioLocks/{hash}`
  - `paymentIntents/{intentId}`
  - `paymentProviderOrders/{hash}`
- Idempotency reservation and folio-lock acquisition are performed in a Firestore transaction.
- The provider network request is performed outside the Firestore transaction.
- Repeated requests with the same idempotency key and same payload return the existing intent; changed payloads conflict.
- A different active intent cannot acquire the same tenant/folio lock.
- Provider order responses are checked against expected amount and currency before the provider-order binding is stored.
- An ambiguous provider outcome is recorded as `UNKNOWN`; the folio lock is retained and a blind retry is not allowed.
- The repository currently resolves membership itself and returns checkout data, but it is not yet exposed through an HTTP route.

**Important limitation:** the repository's current catch boundary still needs refinement. It conservatively treats failures across secret loading, adapter construction and provider dispatch as `UNKNOWN`. The next change must distinguish failures proven to occur before the provider request could be transmitted (eligible for `FAILED_TO_INITIATE` and lock release) from failures after transmission may have begun (must remain `UNKNOWN`). Generic error messages alone are not sufficient proof of pre-dispatch failure.

### Tests currently present

- Provider adapter and state-machine unit tests.
- `test/firestore-repository.test.mjs` uses a serialized fake Firestore transaction implementation to test idempotency, folio-lock contention, payload conflicts, ambiguous outcomes, membership rejection and amount validation.

The fake-store concurrency test is useful unit coverage, **not proof of Firestore Emulator or production Firestore transaction behavior**. A real emulator integration suite has not yet been completed or verified.

## 3. Existing HTTP service

The current `src/server.mjs` exposes:

- `GET /healthz`
- `GET /v1/admin/providers`
- `PUT /v1/admin/providers/razorpay/credentials`
- `POST /v1/admin/providers/razorpay/validate`
- `POST /v1/admin/providers/razorpay/test-orders`
- `POST /v1/admin/providers/razorpay/activate`
- `POST /v1/webhooks/razorpay/{tenantId}/{test|live}`

The Razorpay test-order route is an onboarding/test utility, not the customer payment-intent API. The current server's tenant secret/document helpers are Razorpay-specific. The generic adapter factory, Cashfree adapter, intent state machine, webhook router and Firestore intent repository are not yet integrated into one end-to-end service.

Do not add a second independent authentication or HTTPS implementation in a new router. The eventual payment router must reuse the existing server security middleware and authenticated actor/tenant context.

## 4. Not implemented or not verified

| Component | Current status | Remaining work |
|---|---|---|
| Razorpay adapter | Implemented module; not end-to-end verified | Merchant sandbox checkout, webhook and refund tests |
| Cashfree adapter | Implemented module; not service-wired | Tenant credential lifecycle, HTTP routes, webhook and sandbox tests |
| PayU | Not implemented | Select supported API product/version; obtain merchant staging access |
| PhonePe | Not implemented | Confirm merchant-enabled PG product/API version and staging access |
| Paytm | Not implemented | Confirm merchant product, API contract and staging access |
| CCAvenue | Not implemented | Obtain current merchant integration kit/specification; do not guess crypto or request fields |
| JioPay | Not implemented | Confirm merchant UAT product, credentials and contract |
| Customer payment-intent HTTP API | Not implemented | Authenticated route integrated with repository |
| Actual PMS folio validation | Blocked on schema inspection | Confirm real folio/ledger collection, ownership, open-state and balance calculation |
| Pre-dispatch vs ambiguous failure boundary | Partially implemented; refinement required | Explicit dispatch marker and state-machine-backed failure classification |
| Firestore Emulator tests | Not implemented/verified | Real emulator transaction, contention and cleanup tests |
| Reconciliation worker | Not implemented | Claim/lease, provider status polling, retry policy, alerting and lock resolution |
| Atomic folio ledger posting | Not implemented | Deterministic posting ID and transactionally enforced exactly-once posting |
| Refund lifecycle | Adapter methods exist; lifecycle not wired | Refund intent/state machine, status reconciliation and ledger treatment |
| Pay Bridge payment execution | Not implemented | Extend existing IPC contract after backend intent/session flow is stable |
| Installed-device IPC test | Not verified | Test signed PMS/Bridge APKs on device |
| Owner payment console | Not implemented | Secure owner workflow for provider configuration/onboarding |
| Cloud deployment and operations | Not implemented | GCP project, IAM, secrets, ingress, monitoring, backups and runbooks |

## 5. Execution plan and acceptance gates

Work in this order. Do not skip ahead to live payments.

### Phase 1 — Establish the real PMS accounting contract

1. Inspect the PMS repository's actual folio, reservation and ledger implementation.
2. Identify the authoritative folio ID, tenant/property ownership, open/closed status, outstanding balance calculation, currency and posting model.
3. Confirm whether a successful guest payment is represented as a folio credit/receipt or another ledger event. Do not assume a debit transaction.
4. Define the backend-to-PMS contract and reject client-provided tenant, balance and authoritative amount values.

**Exit gate:** the folio read and ledger posting schemas are evidenced by current PMS source, with tests for tenant isolation and balance calculations.

### Phase 2 — Harden the intent repository

1. Align membership roles with the existing authorization policy.
2. Refine the dispatch boundary: proven pre-dispatch failures become `FAILED_TO_INITIATE` and release the lock; potentially transmitted requests become `UNKNOWN` and retain it.
3. Use `transitionIntent` for every state transition.
4. Align adapter response contracts and provider-specific idempotency/recovery behavior.
5. Validate folio ownership and outstanding balance inside a trusted server-side transaction boundary; protect against balance changes between preflight and reservation.
6. Define lock release rules for every authoritative terminal outcome.

**Exit gate:** deterministic unit tests cover every transition and failure boundary; no generic exception can incorrectly release a possibly paid folio.

### Phase 3 — Authenticated intent API and Firestore Emulator

1. Add the payment-intent router to the existing Express application, reusing existing authentication and HTTPS middleware.
2. Add strict schema validation, integer minor-unit money, request limits, rate limits and safe error responses.
3. Add Firestore Emulator integration tests using the actual repository and actual collection paths.
4. Test same-key concurrency, different-key folio contention, tenant isolation, balance limits, pre-dispatch failure, ambiguous timeout and provider-order binding.
5. Run the complete backend test suite and record CI results.

**Exit gate:** emulator tests and CI pass; the API cannot create an intent against an unowned, closed or insufficient-balance folio.

### Phase 4 — Provider onboarding and reconciliation

1. Wire Razorpay first, then Cashfree, through the common factory and tenant-scoped secret lifecycle.
2. Complete sandbox order creation, actual sandbox payment, signed webhook, status lookup, duplicate/replay/out-of-order event and refund tests.
3. Implement a reconciliation worker with durable leases/claims and provider status verification.
4. Keep ambiguous intents locked until authoritative status resolves them. Never blindly create a second order after a timeout.
5. Add monitoring, alerting, audit events and operational recovery procedures.

**Exit gate:** each enabled provider passes repeatable sandbox end-to-end tests, including ambiguous network outcomes and webhook replay.

### Phase 5 — Exactly-once PMS accounting

1. Implement a deterministic ledger posting identity per captured payment.
2. In a Firestore transaction, verify captured intent binding, tenant, folio, amount, currency and folio state.
3. Post exactly once and update intent/folio lock consistently.
4. Reconcile duplicate captures, late events, partial refunds and full refunds.

**Exit gate:** repeated webhooks and worker retries cannot double-post a folio payment; ledger totals reconcile with provider transactions.

### Phase 6 — Pay Bridge and release

1. Connect the PMS to the backend intent/session flow.
2. Extend the existing Pay Bridge IPC service; do not replace the established Binder/Messenger service contract.
3. Verify caller package/signing identity, message sender UID, schema, amount, currency, intent/session and local journal behavior.
4. Test the production-signed PMS and Bridge APKs installed together on a physical device.
5. Complete security review, deployment controls, backups, alerting and incident runbooks.

**Exit gate:** end-to-end device tests and security review pass. Only then consider controlled live-provider activation.

## 6. Provider scope and implementation order

Implement one provider end-to-end before expanding the provider list. Razorpay is the first integration target because its current onboarding routes already exist. Cashfree follows once the common intent, webhook and reconciliation contracts are stable. PayU, PhonePe, Paytm, CCAvenue and JioPay remain out of scope until their exact merchant product/API contracts and test credentials are available.

A provider is not considered production-ready merely because an adapter file exists or credential validation succeeds. It must pass checkout, payment verification, webhook, reconciliation, refund and ledger integration tests.

## 7. Local development and verification

From `payment-backend/`:

```bash
npm test
```

A Firestore Emulator test command should be added only alongside the emulator test suite and its declared tooling/configuration. The proposed `tests/firestoreEmulator.test.js` from the design discussion is not currently compatible with this repository's filenames, ESM imports, constructor signatures, factory API, collection names or field conventions; do not run it unchanged.

Tests that use a fake Firestore implementation do not establish emulator correctness. Emulator tests do not establish production IAM, Secret Manager, provider sandbox or installed-device correctness.

## 8. Release rule

Until every applicable acceptance gate above passes:

- Keep production/live payment activation disabled.
- Do not expose merchant credentials to clients.
- Do not treat client callbacks or unsigned webhook data as payment proof.
- Do not release a folio lock on an ambiguous provider outcome.
- Do not post a folio payment without a provider-verified captured state and exact binding.
- Do not claim production readiness based on compilation, adapter unit tests or a successful test-order API call alone.
