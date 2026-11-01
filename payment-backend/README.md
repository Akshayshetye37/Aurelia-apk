# Aurelia Payment Backend

Separately deployable Node.js service; not part of either APK. The backend currently has a Razorpay onboarding/API scaffold plus independently tested Razorpay and Cashfree adapter modules. It is **not deployed and is not production-ready**. The adapter modules are not yet wired into authenticated checkout/admin routes or the PMS/Pay Bridge payment lifecycle.

## Security and tenant model

- Admin identity is verified with Firebase Admin SDK, including revoked-token checking, verified email, MFA second-factor claim and a recent authentication window.
- Hotel membership is resolved exclusively from the server-managed Firestore document `paymentMemberships/{firebaseUid}`. The document must contain `tenantId`, `role` (`owner` or `admin` for provider administration), and `status: "active"`.
- A tenant ID supplied in an APK request is never an authorization source. The current membership model intentionally supports one active hotel tenant per Firebase UID. Multi-property membership selection needs a separately designed, server-authorized membership API before it is enabled.
- Provider configuration and status are stored under `paymentTenants/{tenantId}/providers/{provider}_{environment}`. Secret Manager names must be derived from tenant ID, provider, environment and purpose. Secret material must never be returned to PMS or Pay Bridge.
- Webhook URLs include the tenant identifier only as a lookup hint. A valid per-tenant/environment provider signature and server-side provider status fetch are required; tenant path values alone grant no access.
- Credentials remain in Google Secret Manager. PMS and Pay Bridge receive no API secret or webhook secret. Use Cloud Run service identity and Application Default Credentials; never ship service-account key files.
- Firestore membership documents must be provisioned and modified only by a trusted platform administration workflow. Do not grant APK clients write access to membership, payment, provider or webhook collections. Enforce this with Firestore Security Rules and IAM.

## Implemented adapter modules (not yet production-wired)

- `src/providers/razorpay.mjs`: credential validation, INR order creation (paise), server-side payment/order status lookup, raw-body HMAC-SHA256 webhook verification and refund creation.
- `src/providers/cashfree.mjs`: credential validation, hosted checkout session creation, server-side order/payment lookup, timestamp + raw-body webhook signature verification and refund creation.
- Both modules accept an injectable fetch implementation for deterministic contract tests. Amounts are integer minor units at the internal boundary. Provider API secrets remain server-side.
- Automated unit/contract tests cover request auth/header shape, amount conversion, webhook signatures and invalid input rejection.

An explicit adapter factory now instantiates only Razorpay and Cashfree modules; unimplemented providers fail closed. A provider-independent domain module defines INR minor-unit validation, strict tenant/provider/environment/order/amount/currency binding, conservative provider-state normalization and legal payment-state transitions. These are foundational modules only: they are not yet connected to the HTTP service. Their presence does not mean a merchant can accept payments. No sandbox merchant credentials or provider-side end-to-end tests have been run.

## Current HTTP endpoints

- `GET /healthz`
- `GET /v1/admin/providers`
- `PUT /v1/admin/providers/razorpay/credentials`
- `POST /v1/admin/providers/razorpay/validate`
- `POST /v1/admin/providers/razorpay/test-orders`
- `POST /v1/admin/providers/razorpay/activate`
- `POST /v1/webhooks/razorpay/{tenantId}/{test|live}`

The current order endpoint is a sandbox test-order exercise, not a customer checkout session. Webhook handling verifies raw-body HMAC, deduplicates event IDs and independently fetches payment status before marking an order captured. This is not yet a complete PMS folio settlement contract.

## Not implemented / blocked

| Area | Status |
|---|---|
| Cashfree HTTP routes, tenant credential storage, onboarding and webhook inbox integration | Not wired |
| PayU | Not implemented; V2/classic product choice and merchant credentials required |
| PhonePe | Not implemented; merchant-enabled PG product/API version required |
| Paytm | Not implemented; merchant staging/production product configuration required |
| CCAvenue | Not implemented; current merchant integration kit/specification required |
| JioPay | Not implemented; merchant UAT product/credentials required |
| Checkout session API and customer return/status flow | Not implemented |
| Refund lifecycle/status polling | Not implemented at service level |
| Reconciliation worker and ambiguous transaction recovery | Not implemented |
| Atomic, idempotent PMS folio posting | Not implemented |
| Pay Bridge execution protocol beyond the separate IPC handshake foundation | Not implemented |
| Owner web console and backend deployment | Not implemented |

Do not represent a provider as configured/active until its adapter is connected to the tenant-scoped service, official API contract tests and sandbox verification pass, webhook delivery is verified, reconciliation works and end-to-end PMS/Bridge integration passes.

## Required before production

1. Provision an Aurelia-owned Google Cloud project, Firebase Authentication/Identity Platform MFA, Firestore, Secret Manager, Cloud Run, HTTPS domain and least-privilege service identity.
2. Complete server-authorized tenant provisioning, membership lifecycle, account recovery, tenant deletion/export and immutable audit trails.
3. Add rate limiting, abuse controls, alerting, secret rotation/version pinning, operational dashboards, backup/restore and incident runbooks.
4. Wire provider adapters through authenticated tenant-scoped routes and a single payment state machine. Never trust browser/app callbacks as proof of payment.
5. Implement payment reconciliation for ambiguous outcomes, refunds, disputes and atomic idempotent PMS folio posting.
6. Complete provider sandbox checkout, webhook delivery/replay/out-of-order and refund tests, plus installed-device PMS/Pay Bridge tests.
7. Conduct independent security and payment compliance review before enabling live transactions.

## Local verification

Run `npm test` from this directory. Tests validate security-contract source invariants and deterministic adapter behavior; they are not substitutes for integration tests against Firebase, Firestore, Secret Manager or provider sandboxes.
