# Aurelia PMS

Aurelia is an offline-first property-management system (PMS) for reservations, guests, rooms, folios and operations, with an optional hybrid payment backend.

> **Payment release status: LIVE GATEWAY COLLECTION OFF.** Offline cash, manual card-on-delivery and staff-confirmed folio entries remain available on the device. Cloud payment recovery, automatic gateway settlement, native gateway folio projection and live collection are not production-ready and remain fail-closed until the release gates below are completed and approved.


## Latest implementation update (2026-11-07 — payment API hardening)

### Authenticated refund API client

- Extended `src/services/payment-api.mjs` with `createRefund(intentId, options)` and `getRefund(intentId, refundId)`, mapped to the existing tenant-admin refund endpoints.
- Refund creation validates the intent UUID, minimum INR amount in paise, idempotency key, reason length and control characters before any network dispatch. The request uses the authenticated Firebase ID token and sends the same idempotency key in the request body and `Idempotency-Key` header.
- Refund status lookup validates both the intent UUID and the server-issued refund reference before making an authenticated GET request.
- Added regression coverage in `tests/services/payment-api.test.mjs` for authenticated refund creation, request binding, invalid-input rejection before network access and refund status lookup.
- These client methods expose the existing backend API; they do not mean refund controls are enabled in the PMS UI, that a refund has been merchant-tested, or that a refund is reconciled into the PMS folio. Backend release capabilities still report refunds disabled until the accounting and operational release gates pass.

### Verification of the current source revision

- Current verified source commit before this documentation update: `2b9ca36b4b6eb61351aad858428d5cbf761c0abf`.
- GitHub Actions workflow **PMS source tests, web packaging and Android validation** run `42280718865` completed successfully for that commit.
- Settlement foundation CI run `42280662149` completed successfully for `fa38a55688d5b4e91fd39caa35acd822e6c6ccbef`; it predates the final refund-validation correction.
- This verifies the repository workflow, not provider merchant certification, physical-device checkout, cloud deployment, production signing or live-payment readiness.

### Remaining release boundaries

- Android checkout is currently wired only for Razorpay and Cashfree. PayU, PhonePe, Paytm and JioPay have server-side checkout payloads but do not yet have a released Android checkout handoff.
- Provider-specific payment-link creation and lifecycle management are not exposed as a complete Aurelia user workflow.
- Refund API client methods now exist, but refund controls, operational approvals, provider sandbox refund acceptance and folio/accounting treatment are not released.
- Gateway captures are not yet projected into the authoritative PMS folio. The backend reconciliation journal is not a substitute for the application's canonical folio ledger.
- Live collection, automated settlement and live refunds remain disabled. Do not enable them by changing client-side flags.

## Latest implementation update (2026-11-07)

### Optional merchant gateway setup UI (2026-11-07)

- Added a protected owner/admin gateway configuration panel to Payment Settings. It loads provider credential field definitions from the authenticated `/v1/admin/providers` endpoint and supports Razorpay, Cashfree, PayU, PhonePe, Paytm and JioPay.
- Credential submission is sent directly to the trusted backend over HTTPS and requires the existing tenant-admin authentication/MFA controls. The backend stores secrets in Google Secret Manager. The client does not write merchant credentials to local storage, PMS records or APK resources; password inputs are cleared after submission.
- Gateway setup is optional. When no provider is selected, Aurelia's offline-first cash/manual payment, receipt and local folio workflows remain the default. Configuring credentials does not automatically activate a gateway.
- The active gateway can be switched only after credential validation, sandbox acceptance and verified webhook evidence. The backend still enforces one tenant-scoped active provider for new online intents.
- CCAvenue is shown as unavailable/not implemented and is excluded from credential entry because no CCAvenue adapter or end-to-end checkout, webhook, refund and recovery path exists.
- The credential UI is for test/sandbox onboarding only. Live collection remains OFF. PayU, PhonePe, Paytm and JioPay still require Android checkout handoff implementation before device checkout can be offered for those providers.


Working branch: `feature/multi-provider-payment-backend`.

### Tenant-scoped single active provider selection

- Added `payment-backend/src/payment-controls/active-provider-selection.mjs` as the authoritative provider-selection service. It supports the six registered providers: Razorpay, Cashfree, PayU, PhonePe, Paytm and JioPay.
- The selected provider is stored per tenant in `paymentProviderSelection/{tenantId}`. Provider activation/deactivation and the authoritative selection record are updated in one Firestore transaction, with an audit record for each change.
- Activation is fail-closed: the provider must already be configured, its credentials must be validated, its sandbox test must have passed and its webhook must be verified. The existing independent live-collection release gates remain in force.
- New cloud payment-intent creation now checks the tenant's authoritative active provider, public environment and adapter environment. A provider that is not selected for that tenant cannot create a new intent, even if an old provider configuration remains present.
- Provider removal, credential replacement and credential revalidation clear a matching active selection before changing provider state. The capability response now exposes `activeProviderId` and `activeProviderEnvironment` for clients to display the backend's decision.
- Existing in-flight intents and delayed webhooks are not invalidated by a provider switch. Their provider-bound recovery remains necessary to resolve already-created transactions safely.
- Added `payment-backend/test/active-provider-selection.test.mjs` covering atomic switching, qualification rejection, deactivation and malformed-selection fail-closed behavior.

### Current client and release boundary

- The Android checkout selector remains restricted to Razorpay and Cashfree because only those two native handoffs are implemented. PayU, PhonePe, Paytm and JioPay remain unavailable for device checkout until their hosted-checkout handoffs are implemented and physically tested.
- The client-side active-provider display/selection still needs to consume the new `activeProviderId` capability fields consistently; the backend is authoritative and rejects mismatched provider intents regardless of client state.
- The new backend tests and both CI workflows must be reported from GitHub Actions before they are described as passing. The changes are committed to the working branch, but CI status is not assumed here.
- No cloud deployment, merchant sandbox acceptance, physical-device UAT, accounting settlement qualification or production signing is claimed. Live collection, automatic gateway settlement and gateway-to-folio posting remain disabled.

**Operational rule:** configure and qualify one provider, activate it for the tenant, and let the backend enforce that selection for new intents. Do not infer that adapter availability means merchant qualification or production readiness.


## Latest payment configuration update (2026-11-07)

Working branch: `feature/multi-provider-payment-backend`.

### Optional gateway onboarding and default payment behaviour

- Gateway setup is optional. A fresh property does not need to configure an online provider to use Aurelia.
- The existing offline-first cash, manual payment, receipt and local folio workflows remain the default when no online gateway is configured and activated. They must not depend on a payment backend or network availability.
- Payment Settings includes an authenticated owner/administrator configuration panel. It loads provider credential field metadata from the backend and sends submitted merchant values directly to the trusted backend credential endpoint.
- Merchant credentials remain backend-side in Google Secret Manager. The client does not persist submitted merchant secrets in local storage, PMS records or APK resources, and clears secret input fields after submission.
- Six server adapters are currently registered and supported by the active-provider control plane: Razorpay, Cashfree, PayU, PhonePe, Paytm and JioPay. Only Razorpay and Cashfree currently have Android native checkout handoffs. The other four must not be offered for device checkout until their handoffs are implemented and tested.
- CCAvenue is the seventh directory entry only. It is explicitly not implemented and is disabled in the credential selector. No CCAvenue adapter, checkout, webhook, refund or recovery capability is claimed.
- Exactly one qualified online gateway may be active for new intents per tenant. Activation requires validated credentials, sandbox acceptance and verified webhook evidence. Provider switches do not invalidate already-created transactions or their provider-specific recovery.
- The activation endpoint now returns distinct qualification errors: `provider_credentials_not_validated`, `sandbox_acceptance_required` and `webhook_verification_required`.
- Live collection remains OFF. Automatic settlement and gateway-to-folio posting remain disabled until the trusted payment-to-folio lifecycle has passed its separate release gates.

### Verification boundary

The source changes for the optional gateway form, secure credential submission, active-provider enforcement and activation error reporting have been committed to this branch. GitHub Actions runs `42278130693` (payment backend CI) and `42278130696` (PMS source tests, web packaging and Android validation) were in progress at the last status check. Do not treat them as passing until GitHub reports successful conclusions. No cloud deployment, merchant sandbox certification or production release is claimed.

## Project location

- **Repository:** https://github.com/Akshayshetye37/Aurelia-apk
- **Active working branch:** `feature/multi-provider-payment-backend`
- **Project root:** repository root (`/`)
- **Primary application entry:** `index.html`
- **Android host:** generated by Capacitor during CI from the app configuration and native templates under `android/templates/` (the generated Gradle project is not committed as the source tree)
- **Cloud payment backend:** `payment-backend/`
- **Application code:** `src/`
- **Tests:** `tests/` and `payment-backend/test/`

The GitHub repository and selected branch are the source of truth. The repository is not a local filesystem path on the user's device.

## Product architecture

**Selected architecture: local-first PMS + trusted cloud payment authority.**

The PMS remains usable offline for hotel operations. Its existing local booking/folio structure remains the live application's accounting model. The cloud backend is an optional, separate payment authority. It owns provider credentials, provider API calls, webhook ingress, provider-side status verification and payment-intent evidence. A trusted native bridge is required before verified cloud capture can mutate a local folio.

```text
Android / Capacitor PMS
  ├─ Offline application and local booking/folio data
  ├─ Existing guarded settlement service
  └─ IndexedDB pending-command journal
          │ authenticated HTTPS (not yet fully wired into UI/session)
          ▼
Cloud payment backend
  ├─ Firebase identity + tenant membership checks
  ├─ Firestore payment intent / control-plane records
  ├─ Google Secret Manager for merchant credentials
  ├─ Provider adapters + raw webhook verification
  └─ Provider status evidence and reconciliation controls
          │
          ▼
Trusted native authorization + local folio projector
  NOT INSTALLED / NOT RELEASED
```

The `payment-backend/src/server.mjs` Firebase Admin + Firestore + Secret Manager service is the selected cloud foundation. Terraform defines an external managed HTTPS load balancer, serverless NEG, managed TLS certificate, HTTPS-only TCP/443 frontend (no TCP/80 listener) and Cloud Armor per-IP throttling in front of Cloud Run. The Cloud Run security model documents that HTTPS load-balancer requests are forwarded to the Cloud Run container over a Google-managed encrypted channel. The URL map also emits `Strict-Transport-Security: max-age=63072000` to enforce HTTPS in supporting browsers after their first secure visit. The backend service `protocol = "HTTPS"` field is retained, but Google ignores that field for serverless NEG backends; it is not the control that provides this encryption. Deployment still requires owner-controlled cloud project configuration, an immutable Artifact Registry image digest, API domain and DNS record, workload identity, exact HTTPS origins, Firestore and Secret Manager permissions. No infrastructure apply or production deployment has been performed. The `payment-backend/src/local-server.mjs` SQLite/LAN server is a separate development/administration runtime; it is not the public cloud payment authority and must not be used as a provider webhook ingress substitute.

## Payment release status

### Six-provider cloud integration status

| Provider | Factory / cloud API | Credential onboarding | Test checkout / webhook / refund interfaces | Android checkout handoff | Live collection |
|---|---|---|---|---|
| Razorpay | Wired | Secret Manager + validation | Implemented; sandbox acceptance pending | Native SDK wired; UAT pending | Blocked |
| Cashfree | Wired | Secret Manager + validation | Implemented; sandbox acceptance pending | Native SDK wired; UAT pending | Blocked |
| PayU | Wired | Secret Manager + validation | Implemented; sandbox acceptance pending | Hosted-checkout handoff pending | Blocked |
| PhonePe | Wired | Secret Manager + webhook username/password validation | Implemented; sandbox acceptance pending | Hosted-checkout handoff pending | Blocked |
| Paytm | Wired | Secret Manager + websiteName validation | Implemented; sandbox acceptance pending | Hosted-checkout handoff pending | Blocked |
| JioPay | Wired | Secret Manager + UAT credential validation | Implemented; sandbox acceptance pending | Hosted-checkout handoff pending | Blocked |
| CCAvenue | Not implemented; documentation only | Not available | Not available | Documentation only | Blocked |

The canonical factory order is `razorpay, cashfree, payu, phonepe, paytm, jiopay`. All six server adapters expose test/UAT/staging order, status, webhook and refund interfaces. The Android native checkout UI currently dispatches only Razorpay and Cashfree; PayU, PhonePe, Paytm and JioPay must remain unavailable in the device checkout selector until their hosted-checkout handoffs are implemented and tested. The client rejects those four before creating a cloud intent, avoiding orphaned folio locks. Provider checkout and refunds are test-environment only. Provider credentials are written through Secret Manager; the save route validates them before marking onboarding complete. The webhook ingress dynamically selects the provider adapter and verifies the original raw request body before fetching provider status. Recovery uses provider-specific environment and status mappings, and ambiguous create/refund operations are never blindly redispatched.

Refund initiation is exposed only for a captured test payment through `POST /v1/payments/intents/:intentId/refunds`; status recovery uses `GET /v1/payments/intents/:intentId/refunds/:refundId`. Refund reservations are idempotent and bounded by the captured amount. These routes record provider refund evidence only; they do not post a PMS folio or claim canonical accounting settlement.

All six providers remain live-disabled. Merchant UAT, canonical folio settlement, physical-device acceptance, refund lifecycle acceptance, security review and owner release approval remain mandatory before any live collection capability can be enabled. CCAvenue is excluded from factory, cloud routes and active device configuration; its documentation entry is retained only for reference.

### Offline persistence implementation boundary

- The PMS core currently persists its application state through the existing browser storage layer (localStorage and IndexedDB). The native Android payment journal is SQLite-backed, but it is not the complete PMS database.
- A full encrypted SQLite/SQLCipher store for all rooms, guests, bookings, folios, receipts and local audit records, with its database key wrapped by Android Keystore, is **not yet implemented**. Existing durable-write and read-back checks do not equal at-rest database encryption.
- Offline-first cash/manual operations are designed to work without the payment backend. Production acceptance must still verify offline CRUD, restart/restore, storage quota handling and Android persistence on physical devices. Do not describe the current core store as encrypted SQLite.

### Credential and device-storage boundary (mandatory)

- Merchant API keys, salts, webhook secrets and provider signing credentials are backend-only and are stored in Google Secret Manager. They must never be entered into the APK, WebView, SharedPreferences, SQLite, IndexedDB, application backup folders or device-local files.
- Android Keystore is reserved for device identity/enrollment material and local database-key wrapping. It is not a merchant credential vault and does not hold provider keys.
- The former Android Keystore-backed merchant credential vault has been retired. Its upgrade migration deletes the legacy `gateway-vault` files and `aurelia.local.gateway.v1` Keystore alias. Native attempts to save or activate merchant credentials now fail closed with `merchant_credentials_must_be_managed_by_trusted_backend`.
- Ordinary PMS operations remain local-first. Cash, manual card-on-delivery and staff-confirmed manual folio entries use the local settlement service without a network or payment backend. The optional cloud payment backend is not a prerequisite for ordinary hotel operations. The local manual-payment boundary is enabled; automatic gateway settlement and native gateway folio projection remain independently locked. The current application runtime must still pass the platform-specific persistent-storage checks before it may report a durable save.
- The tenant live-collection switch is not an internal release switch. The server requires both `live_collection` (internal release approval) and `live_collection_enabled` (tenant-admin choice), with MFA and role checks on the control API. Missing, malformed or unreadable control state fails closed. Both values remain false until release evidence is approved.
- A separate master `emergency_stop` defaults to engaged and dominates every capability. The tenant UI can engage it but cannot clear it; only the platform operator's separately controlled release procedure may clear it. Initialising a tenant control document therefore does not activate test checkout or live collection.
- Turning the tenant switch off blocks new live orders. It does not rewrite or silently settle in-flight intents; unresolved intents must remain pending/reconciliation-required for server-side review.

### Provider Directory labels

The app displays `Server adapter ready (test) · Live collection OFF` for Razorpay, Cashfree Payments, PayU, PhonePe, Paytm and JioPay. This label means a server adapter is wired for its non-live environment; it does **not** certify that the merchant's sandbox matrix, refund lifecycle, recovery or device-to-folio path has passed acceptance. CCAvenue is documentation only and is not in the active provider factory.

The Payment Gateway screen explains that the hybrid backend is optional and that local cash/manual payments continue to work from device memory. Gateway checkout callbacks are UI-only signals; capture authority comes from verified provider webhooks or a recovery job that independently re-checks provider status. A local staff-confirmed payment is not a gateway capture and must never be inferred from a client callback.

### Implemented foundations (source inspection)

- Cloud backend with Firebase ID-token verification, tenant membership and role checks.
- Owner/admin payment-control API with fail-closed defaults, transactional control audit and evidence-gated capability changes.
- Google Secret Manager integration for provider credentials.
- Six server-side provider adapters (Razorpay, Cashfree, PayU, PhonePe, Paytm and JioPay) are wired for their test/UAT/staging environments, with provider-specific credential validation, checkout, status, webhook and refund interfaces. Adapter wiring is not sandbox acceptance evidence. Razorpay refund responses are bound to the requested payment, INR amount and refund identity; Cashfree uses its current documented API version and strict merchant/provider refund ID and amount binding. Cashfree now targets the current documented `2026-01-01` API version. Refund creation and lookup preserve the merchant-supplied `refund_id` as the API lookup key and store `cf_refund_id` separately; responses are bound to the requested order, payment and INR amount. Cashfree order/payment/refund amounts are converted from rupees to paise only when the provider response has valid two-decimal precision.
- Payment-intent persistence and server-side capability reporting. Intent idempotency and provider-order uniqueness are namespaced by tenant, provider, environment and merchant account. Ambiguous `DISPATCHING`/`UNKNOWN` requests are recovered only by deterministic provider-reference lookup; no second create-order request is issued by reconciliation.
- Authenticated `POST /v1/payments/intents/:intentId/reconcile` performs server-to-server provider status lookup and binds capture to the stored provider order, merchant account, payment ID, exact INR amount and currency. A verified capture moves the cloud intent to `CAPTURED` while its accounting status remains `PENDING`; this endpoint never writes a PMS folio. Late verified capture can supersede a prior provider failure without opening accounting.
- Raw-body webhook ingress and provider status verification logic. Webhook inbox replay keys are additionally bound to the exact signed request-body SHA-256 fingerprint and tenant/provider/environment/order/payment identity; changed payloads reusing an event ID are rejected.
- Bounded reconciliation worker prototype; the exposed reconciliation endpoint remains blocked because it writes to a separate Firestore payment-folio model, not the current PMS local folio ledger.
- Local settlement service, IndexedDB command journal and read-only accounting diagnostic covering paid-total drift, duplicate payment identities, compatibility-history mismatches, malformed or unbalanced cancellation journals, duplicate journal IDs, repeated cancellation postings and cancellation/refund status flags without matching journal evidence.
- PMS JSON imports now run as a transaction: they snapshot the live application state, merge into the in-memory model, persist once, verify every durable state collection by read-back, and restore the prior state plus booking ID sequence if persistence or verification fails. A rollback that cannot be verified raises an explicit critical warning rather than silently continuing with a partial import.
- Backup restore now enforces a 50 MiB input ceiling and per-collection/aggregate record limits before staging. Both incremental JSON imports and full snapshot restores use strict persistent writes with exact storage read-back; failed full restores attempt to restore both the prior photo archive and application state, verify the rollback, and raise an explicit critical warning if either rollback cannot be proven.
- Imported booking records reject invalid date ranges, stays longer than ten years, negative/non-finite/unsafe payment amounts, sub-paise precision, and malformed explicit nightly rates before the records can enter the PMS state.
- Fresh installations start with empty property inventory, guest, booking, restaurant-table and revenue state. Fictitious demonstration reservations and takings are not preloaded into a live hotel's operational dashboard.
- Cancellation/refund workflow blocks a refund from being marked paid without explicit settlement confirmation and an external bank/provider transaction reference. Pending refunds remain refund-payable liabilities. Journal idempotency now prevents duplicate cancellation postings and allows a pending liability to be settled only once for the exact originally recorded amount. This is an operator control, not automated bank reconciliation or proof-of-payment integration. Cancellation journal commits now also require durable local-storage read-back of the exact cancelled-booking fields, financial ledger and audit history before the UI reports success; failed verification restores the in-memory snapshot and attempts rollback persistence.
- Authenticated payment API client at `src/services/payment-api.mjs` is wired to the MFA-aware Firebase web session. The web payment client obtains fresh short-lived Firebase ID tokens from the existing MFA-aware `AureliaPaymentAuth` session; cloud enrollment, lease polling and acknowledgement requests carry the token together with the native device request signature.
- Razorpay Android Standard Checkout and Cashfree Android Web Checkout are wired into the generated Android host. Checkout callbacks are treated only as wake-up signals; the PMS re-reads the cloud intent and does not trust SDK callbacks as proof of capture. Cashfree uses the documented Android SDK artifact `com.cashfree.pg:api:2.6.1`, its `payment_session_id`, and Android 11+ UPI package-visibility declarations. The Android build pipeline still needs to pass after these changes, and merchant sandbox UAT has not been performed.
- Android Keystore currently holds device-bound identity/enrollment material only. Full PMS encrypted SQLite storage and a Keystore-wrapped database key are not yet implemented. The legacy device-local merchant credential vault is retired and its files/key alias are purged by the migration guard. Provider checkout is restricted to the test environment in the native bridge. Live collection remains blocked.
- The trusted settlement issuer/projector, complete tenant/device/provider-account authorization binding, canonical local folio reconciliation, refund lifecycle and full end-to-end acceptance remain outstanding. The current checkout integration must not be described as production-ready.
- LAN SQLite settlement hardening: database triggers now bind every inserted device command to the exact captured transaction (device, folio, amount and currency), make queued command payloads immutable, and reject a `SETTLED` transaction unless its command has a processed durable receipt, verified receipt signature field and advanced device cursor. This protects the LAN transport journal; it does **not** make the separate Android IndexedDB folio write and LAN SQLite acknowledgement one cross-database ACID transaction.

- Payment backend runtime hardening: Express 4 asynchronous route and middleware failures are forwarded to controlled error handling; parser failures are classified separately from internal 5xx failures, and payment repository errors are sanitized rather than exposing provider or infrastructure exception messages.
- Cloud Run lifecycle hardening: the image runs as non-root, SIGTERM/SIGINT drain in-flight HTTP requests and close Firestore/Secret Manager clients, HTTP request/header timeouts are bounded, and Terraform defines supported startup and liveness probes; Cloud Run manages instance readiness.
- Payment-intent recovery refuses to overwrite an existing provider-order binding with a different tenant, folio, intent, provider, environment, amount or currency. Conflicting recovery evidence leaves the intent and folio lock in UNKNOWN for investigation.
- Provider credential removal disables every enabled Secret Manager version instead of deleting secret resources; the runtime IAM role does not receive project-wide secret deletion permission.
- Webhook verification preserves an already activated provider, and test-order webhook records now retain the exact provider order ID required for payment binding. Test orders are blocked until test credentials have been validated.
- The local SQLite driver is excluded from the Cloud Run production image.
- Payment backend CI checks the non-root image configuration and validates Terraform formatting and configuration in addition to backend tests and container build.
This is source/CI verification only: it does not prove physical-device acceptance, provider merchant certification, Cloud Run deployment, production webhook reachability or live payment collection. The latest recorded Android validation run (`41885511317`, commit `9e0ed6b582ac79996683b812f67ded4c29ea2c54`) completed the full PMS test suite, production web build, production asset privacy checks, Capacitor Android generation and sync, Android debug APK build, APK identity/signature verification, merged-manifest permission audit and debug artifact upload. This is a CI-generated debug validation APK, not a signed production release.

No APK artifact, signed production release, production Cloud Run deployment, live merchant payment, or installed-device payment round trip is claimed. Live collection and settlement remain fail-closed until the integrated PMS accounting pipeline and production acceptance evidence are complete.

### Newly verified payment recovery behavior

- Repeated intent reservation now returns the original provider reference and actual stored intent state.
- An ambiguous provider-order creation is recovered by read-only lookup using its deterministic provider reference; the backend does not blindly dispatch a second order.
- Recovery validates the provider order identity, amount and currency before restoring the intent to its created state.
- An inconclusive provider lookup leaves the intent in an unknown/reconciliation-required condition and preserves the folio lock.
- Cashfree recovery retains its checkout session/reference for resuming the original checkout.

### Still release-blocking

- The trusted standalone Android Pay Bridge application source/package `com.aurelia.paybridge` is not present in this repository. The checked-in PMS-side client/templates do not implement the complete bridge service, trusted one-time authorization issuer/verifier, or canonical local settlement projector.
- The cloud backend is not yet transactionally connected to the authoritative local PMS folio and receipt/audit path.
- Full provider lifecycle acceptance (including refunds and refund-status verification), physical-device recovery tests, real-data accounting review, production infrastructure deployment and provider merchant certification remain outstanding.

**Release decision: keep live collection, automatic gateway settlement and gateway-to-folio posting interlocks closed. Offline cash and staff-confirmed manual folio entries remain available on-device.**


### Settlement authorization v2 foundation (integration incomplete)

The active branch now contains a hardened local settlement foundation:
- Strict canonical JSON encoding rejects circular references, non-finite numbers, unsupported values and undefined properties before hashing or signature verification.
- ECDSA P-256 verification uses pinned public JWKs and v2 signed envelopes with issuer/audience, short authorization lifetime, bounded policy-lease lifetime, and exact tenant, device, provider merchant-account, environment, command, booking, amount and payment-reference binding.
- Local idempotency identity is namespaced by tenant, provider, provider account, environment and provider transaction/command identity. Device identity remains a mandatory authorization binding, but is not part of the provider-transaction idempotency namespace.
- IndexedDB journal schema v2 performs index migration for existing stores, uses serialized read-write transactions, records immutable payload hashes, and enforces PENDING-to-APPLIED/REJECTED terminal transitions.
- The local projector requires an explicitly synchronous persistence adapter, re-verifies authorization and lease before posting, and checks the complete immutable settlement identity on durable read-back.
- Root test suite now includes concurrency and cross-tenant idempotency coverage using the declared fake-indexeddb development dependency.

**This is not an end-to-end payment release.** The cloud backend now contains a P-256 settlement signer, device command-lease path and webhook-driven command creation after provider verification. The authenticated Pay Bridge handshake and local projector foundations exist, but the complete trusted Android payment-to-folio execution, durable acknowledgement/recovery and canonical local folio reconciliation path are not release-qualified. Offline cash and staff-confirmed manual folio entries remain available. Live collection, automatic gateway settlement and gateway-to-folio posting remain disabled. Do not connect the projector to production payment flows until the end-to-end native device trust, durable persistence, sandbox acceptance and release evidence are verified.


## Latest production-development update (2026-11-06)

Working branch: `feature/multi-provider-payment-backend`.

### Dependency readiness probe hardening

- `payment-backend/src/http/readiness-probe.mjs` contains the reusable readiness contract. It evaluates Firestore and Secret Manager independently and reports ready only when both checks succeed.
- `payment-backend/src/server.mjs` now checks Firestore access and calls Secret Manager `accessSecretVersion` for `aurelia-payment-backend-health/versions/latest`. A metadata-only secret lookup is no longer treated as proof of readiness.
- Secret Manager readiness requires a non-empty accessible payload. The payload is never included in the HTTP response; `/readyz` exposes only boolean `firestore` and `secretManager` checks and returns HTTP 503 when either dependency check fails.
- `payment-backend/test/readiness-probe.test.mjs` adds regression coverage for successful dependency access, empty secret payloads, dependency failures and supported payload representations.
- `.github/workflows/payment-backend-ci.yml` now runs `node --check` over backend `.mjs` source and test modules after the backend test command.

### Latest commits

| Commit | Change |
|---|---|
| `797c7bb` | Verify Secret Manager version access in readiness |
| `4d9f754` | Extract reusable dependency readiness probe |
| `bf42c9d` | Add fail-closed readiness regression tests |
| `be8c186` | Add backend module syntax validation to CI |

The latest branch head was verified as `be8c1867e98c185de40f5f01b9e8c9e9a4afb549` when this section was written. GitHub had not yet reported workflow check results for that commit. The source changes and CI configuration were fetched back from the branch, but the new Node tests and syntax checks must not be described as executed until GitHub Actions reports their result.

**Release status is unchanged:** this readiness improvement does not enable live payments, authorize settlement, install the missing standalone trusted Android Pay Bridge, or complete the cloud-to-local-folio accounting integration. Keep live collection and gateway-to-folio posting disabled.


## Embedded preview storage limitation (2026-11-06)

- The CodeShack live preview runs the application inside the embedded about:srcdoc sandbox. When that sandbox does not grant a same-origin storage context, browser localStorage is unavailable. Aurelia explicitly switches to a session-memory fallback in that environment.
- Session-memory mode is **not durable**: records may disappear when the preview is reloaded or closed. Do not enter real guest, booking, financial, or operational records in this preview.
- window.AureliaStorageDiagnostics now exposes the detected storage mode, whether the app is in an embedded preview, and the reason durable storage is unavailable. The app warning identifies this as an embedded-preview restriction instead of incorrectly implying that the device is necessarily full.
- Strict persistence operations continue to reject writes in memory-only mode. This is intentional fail-closed behavior; the app must never report a successful durable save when data exists only in RAM.
- Use a first-party HTTPS deployment with browser storage enabled, or a verified installed Android build with its native durable storage integration, for operational data. Merely opening the CodeShack preview in a larger viewport does not change its sandbox origin or grant persistent storage.
- The latest change does not migrate existing preview-memory records into durable storage. Export a backup while the current preview session is still open if it contains data you need to retain.

Latest storage-diagnostics commits: 7e6776c (runtime diagnostics and accurate warning) and fa70730 (regression test).


## Latest implementation update (2026-11-06)

Working branch: feature/multi-provider-payment-backend.

### Tenant live-collection control separation

The payment control plane now models two independent conditions:

- live_collection: internal release authorisation. Enabling this capability remains subject to the existing owner-evidence approval mechanism.
- live_collection_enabled: tenant operational switch. It defaults to false, is included in the payment-control audit record, and cannot be enabled unless internal live authorisation is already active.
- The central emergency stop remains dominant. Missing or unreadable payment-control state fails closed.
- Legacy payment-control documents that predate live_collection_enabled are read with the new switch defaulted to false.

The backend live gate checks the tenant control state, emergency stop, internal authorisation, tenant switch and provider qualification. The live gate is applied to the relevant credential, checkout, refund, provider activation and webhook request paths. Provider qualification still reports live collection as disabled for all six providers. No client-facing control can grant internal authorisation.

Webhook ingress now applies a provider-specific Content-Type allow-list before signature processing. Raw-body signature verification and trusted-order binding remain required.

### Android build pipeline correction

The Android generator now excludes the duplicate META-INF/versions/9/OSGI-INF/MANIFEST.MF resource that caused the Android Gradle mergeDebugJavaResource task to fail. The earlier Java JSON-string escaping correction is also retained. The latest Android workflow must complete successfully before this is considered verified.

### Verification at the time of this update

- Backend CI for commit 13ea2e8bc00011981ca4abb6aad1e76fcc360aae: **passed**.
- PMS source tests, web packaging and Android validation for that commit: **still running** at the time of documentation.
- The previous failed backend run exposed a regression-test fixture issue in the new approval separation; the fixture/approval path was corrected, and the subsequent backend CI passed.
- This CI result is not provider sandbox UAT, physical-device acceptance, production deployment or proof of payment-to-folio settlement.

### Current production-readiness status

Implemented foundations include the six-provider adapter registry, test-environment checkout and webhook integration, Secret Manager credential storage, provider status recovery, replay-aware webhook processing, payment-control audit, local accounting safeguards, backend readiness checks and Android checkout integration foundations.

The following are still release-blocking:

1. Complete a canonical, server-authoritative payment-to-folio settlement path that is transactionally safe or uses a durable transactional outbox. It must bind tenant, folio, intent, provider, merchant account, environment, provider order/payment identity, exact amount and currency.
2. Ensure all six providers' verified captures use the same idempotent settlement function. Client return URLs and SDK callbacks must remain UI signals only.
3. Complete refund initiation, provider refund status verification, partial-refund accounting, folio credit/credit-note posting and settlement journal entries with idempotent recovery.
4. Complete the trusted Android Pay Bridge, cloud authorization issuer, device trust and one-time signed settlement authorization integration. The standalone com.aurelia.paybridge application is not present in this repository.
5. Connect the tenant-admin live switch to the authenticated cloud payment-control API and enforce recent MFA at the toggle action. The current PMS settings page is not yet wired to that API; do not represent a local UI preference as a live control.
6. Complete webhook security review: provider-specific content-type and body-size policy, environment binding, event-ID uniqueness, source rate limiting and provider IP allow-lists where reliable published ranges exist, and uniform externally visible rejection behavior.
7. Complete end-to-end sandbox acceptance for Razorpay, Cashfree, PayU, PhonePe, Paytm and JioPay, including credential onboarding, checkout, signed webhook, status recovery, duplicate delivery, amount mismatch, full/partial refunds and exact folio reconciliation.
8. Complete Cloud Run and HTTPS load-balancer deployment with owner-controlled project, domain/DNS, TLS, workload identity, least-privilege Firestore/Secret Manager IAM, alerting, logs, monitoring, backups and incident-response runbooks.
9. Complete web and installed Android physical-device acceptance, production signing/release verification, security review and owner sign-off.

**Release decision:** keep live collection, automatic settlement and gateway-to-folio posting disabled. No production deployment, live merchant certification or live payment acceptance is claimed. A successful backend CI run does not establish production readiness.

## Project location

- GitHub repository: https://github.com/Akshayshetye37/Aurelia-apk
- Active branch: feature/multi-provider-payment-backend
- Root: / (repository root)
- Main app: index.html
- Cloud payment backend: payment-backend/
- Android source templates: android/templates/
- Root application modules: src/
- Root tests: tests/
- Payment backend tests: payment-backend/test/
