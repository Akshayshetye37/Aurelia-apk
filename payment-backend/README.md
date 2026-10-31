# Aurelia Payment Backend

Separately deployable service; not part of either APK. This repository currently contains a **Razorpay-only reference adapter**. It is not deployed and is not production-ready. The remaining provider adapters and complete payment lifecycle are not implemented.

## Security and tenant model

- Admin identity is verified with Firebase Admin SDK, including revoked-token checking, verified email, MFA second-factor claim and a recent authentication window.
- Hotel membership is resolved exclusively from the server-managed Firestore document `paymentMemberships/{firebaseUid}`. The document must contain `tenantId`, `role` (`owner` or `admin` for provider administration), and `status: "active"`.
- A tenant ID supplied in an APK request is never an authorization source. The current membership model intentionally supports one active hotel tenant per Firebase UID. Multi-property membership selection needs a separately designed, server-authorized membership API before it is enabled.
- Provider configuration and status are stored under `paymentTenants/{tenantId}/providers/razorpay_{environment}`. Secret Manager names are derived from tenant ID, provider, environment and purpose. Payment order, idempotency and webhook inbox records carry tenant binding.
- Webhook URLs include the tenant identifier only as a lookup hint. A valid per-tenant/environment Razorpay HMAC and server-side payment fetch are still required; tenant path values alone grant no access.
- Credentials remain in Google Secret Manager. PMS and Pay Bridge receive no API secret or webhook secret. Use Cloud Run service identity and Application Default Credentials; never ship service-account key files.
- Firestore membership documents must be provisioned and modified only by a trusted platform administration workflow. Do not grant APK clients write access to membership, payment, provider or webhook collections. Enforce this with Firestore Security Rules and IAM.

## Current endpoints

- `GET /healthz`
- `GET /v1/admin/providers`
- `PUT /v1/admin/providers/razorpay/credentials`
- `POST /v1/admin/providers/razorpay/validate`
- `POST /v1/admin/providers/razorpay/test-orders`
- `POST /v1/admin/providers/razorpay/activate`
- `POST /v1/webhooks/razorpay/{tenantId}/{test|live}`

The order endpoint is currently a sandbox test-order exercise, not a customer checkout session. Webhook handling verifies the raw-body HMAC, deduplicates event IDs and independently fetches the payment before marking an order captured. This is not yet a complete PMS folio settlement contract.

## Required before any production use

1. Create an Aurelia-owned Google Cloud project and configure Firebase Authentication/Identity Platform MFA.
2. Configure Firestore, Secret Manager, Cloud Run, HTTPS domain, exact allowed origins, least-privilege service identity and deny-by-default Firestore rules.
3. Implement and security-review platform tenant provisioning, membership lifecycle, account recovery, tenant deletion/export and audit trails.
4. Add rate limiting, abuse controls, alerting, secret rotation/version pinning, operational dashboards, backup/restore and incident runbooks.
5. Complete real Razorpay sandbox checkout, webhook delivery/replay/out-of-order tests and end-to-end PMS/Pay Bridge integration.
6. Implement reconciliation for ambiguous order/payment states, refunds, dispute handling and atomic idempotent PMS folio posting.
7. Conduct independent security review and payment compliance review before enabling live transactions.

## Provider status

| Provider | Backend adapter | Status |
|---|---|---|
| Razorpay | Partial reference adapter | Sandbox onboarding scaffold only; no deployed service or end-to-end checkout |
| Cashfree | Not implemented | Disabled |
| PayU | Not implemented | Disabled |
| PhonePe | Not implemented | Disabled |
| Paytm | Not implemented | Disabled |
| CCAvenue | Not implemented | Disabled |
| JioPay | Not implemented | Disabled |

Do not represent provider credentials as configured/active until a provider-specific server adapter, official-doc contract tests, sandbox verification, webhook verification, reconciliation and complete PMS/Bridge integration have all passed.

## Local verification

Run `npm test` from this directory. Tests currently validate security-contract source invariants; they are not substitutes for integration tests against Firebase, Firestore, Secret Manager or a provider sandbox.
