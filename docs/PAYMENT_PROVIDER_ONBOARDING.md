# Aurelia Payment Provider Onboarding and Credential Contract

Status: research and integration contract. This document does not mean the provider adapters or production backend are implemented.

## Non-negotiable trust boundaries

- **PMS APK:** hotel UI, folio reference, amount display, launch/return from checkout, and staff review.
- **Aurelia Pay Bridge APK:** native companion IPC and (when implemented) provider-specific checkout handoff and transaction evidence.
- **Owner-controlled HTTPS backend:** merchant credentials, token generation, payment/order creation, signature/hash verification, webhook endpoints, status polling, idempotency, refunds, reconciliation, and provider activation.
- Never enter API secrets, salts, private keys, passwords, or webhook secrets into PMS or Pay Bridge APK fields, local preferences, HTML, JavaScript bundles, logs, or Git.
- The Pay Bridge handshake authenticates the companion APK. It does **not** authenticate a merchant's Razorpay/Cashfree/PayU/etc. account.
- A provider is not active because an identifier was typed or a local preference was saved. Activation requires backend credential validation, a provider-specific test transaction, webhook verification, and an explicit owner enable action.
- No unverified callback, redirect, screenshot, or client-side event may settle a folio. Keep staff confirmation mandatory.

## Provider credential matrix (India)

| Provider | Public / non-secret identifier | Secret material (backend only) | Other configuration | Official references |
|---|---|---|---|---|
| Razorpay | Key ID (test/live) | Key Secret; separate webhook secret configured for webhook signature verification | Test or Live mode; webhook URL/events; account and website activation | [Standard Checkout](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/), [Webhooks](https://razorpay.com/docs/webhooks/), [Security checklist](https://razorpay.com/security/checklist/) |
| Cashfree Payments | App ID | Secret Key; use the current webhook signature verification scheme and secret associated with the merchant account | Test or Production; API version; webhook endpoint | [API overview](https://www.cashfree.com/docs/api-reference/payments/latest/overview), [Webhook verification](https://www.cashfree.com/devstudio/preview/pg/tools/webhookVerification) |
| PayU India | Merchant Key | Salt (v1/v2 as applicable to the selected API); keep any partner client secret separate | Test or Live; API product/version; success/failure URLs; webhook endpoint | [Authentication](https://docs.payu.in/reference/authentication-with-payu-apis), [Test key and salt](https://docs.payu.in/docs/generate-test-merchant-key-and-salt), [Production key and salt](https://docs.payu.in/docs/generate-merchant-key-and-salt-on-payu-dashboard) |
| PhonePe PG Standard Checkout V2 | Client ID | Client Secret; callback validation username/password (configured for webhook authentication) | Client Version; Sandbox or Production; callback/webhook URL. Do not use deprecated V1 salt-key flow for V2 | [Official PhonePe Node SDK](https://github.com/PhonePe/phonepe-pg-sdk-node), [Official docs registry](https://github.com/PhonePe/phonepe-pg-docs-mcp), [PhonePe developer portal](https://developer.phonepe.com/) |
| Paytm PG | MID (Merchant ID); Website/channel value; Client ID only where that API/product requires it | Merchant Key; never expose it in the APK | Staging or Production; callback URL; webhook URLs and event configuration | [Merchant onboarding and credentials](https://business.paytm.com/docs/get-started-with-paytm-integration-merchant-onboarding/), [Custom Checkout](https://business.paytm.com/docs/v1/custom-checkout), [Callbacks and webhooks](https://business.paytm.com/docs/callback-and-webhook/) |
| CCAvenue | Merchant ID; Access Code (the access code is not a substitute for the working key) | Working Key; any additional encryption/integration material issued in the merchant-specific integration kit | Merchant-approved integration type (web/mobile SDK); test/production details as issued by CCAvenue | [Merchant FAQ](https://www.ccavenue.com/faq), [In-App Payments](https://www.ccavenue.com/inapp-payments), [Merchant onboarding](https://www.ccavenue.com/compliance) |
| JioPay | No universal public field schema verified | Obtain exact credential names and cryptographic contract from the merchant-specific JioPay integration kit | Product, environment, callback signature, status API and SDK/API version must be confirmed with JioPay | [Official JioPay site](https://www.jiopay.com/) |

### Notes on credential accuracy

- Razorpay Key ID may be used as the checkout's public key identifier, but Key Secret remains server-side. The backend creates the order; the app receives only the order/checkout data needed by the client.
- Cashfree's API overview identifies separate test and production API hosts. Use the current API version selected by the implementation; never hardcode a stale API version into merchant settings.
- PayU has different API generations and hash formats. Do not assume a single Salt field or one hash recipe applies to every PayU product. Select the exact API product/version and use its official current specification.
- PhonePe V2 uses Client ID, Client Secret and Client Version. Its official Node SDK also documents callback validation with a configured username/password. These are backend secrets. V1 salt-key/index configuration must not be mixed into V2.
- Paytm MID and Merchant Key are the core account credentials described by Paytm. Website/channel and Client ID requirements vary by product/API.
- CCAvenue's merchant integration kit is account/product-specific. The official CCAvenue FAQ and onboarding material must be used to confirm the exact fields supplied to the merchant.
- Public JioPay material did not expose a verifiable universal PG API credential schema during this review. Do not invent fields or claim JioPay support is ready.


## Provider onboarding boundary

**Credential entry in the PMS APK is disabled.** The earlier prototype accepted an arbitrary HTTPS URL, a bearer token and provider secrets inside the APK. HTTPS alone does not establish that a destination is an owner-controlled endpoint, so that design could send merchant secrets to an attacker-controlled host. The current PMS screen is documentation/status-only and must not collect provider credentials.

The production owner console must be a separately hosted, owner-authenticated web application on a pinned, owner-controlled origin. It must use MFA-backed sessions, CSRF protection where cookie sessions are used, strict origin/CORS policy, provider-specific schemas, managed envelope encryption, secret redaction, audit events without secret values, key rotation, and non-secret status projections. PMS may display only provider ID, environment, validation state, activation state and last-check timestamp. It must never receive or store merchant secrets.

The endpoint shape below is a proposed backend contract, not a deployed service: `PUT /api/admin/payment-providers/{providerId}/credentials` with `{ provider, environment, credentials }`. The backend must authenticate an owner/admin, enforce an exact provider schema, reject unknown fields, encrypt secrets at rest, redact request bodies from logs/traces, and return only a non-secret status projection. HTTP success is not activation. Activation requires provider-specific validation, a verified webhook, an independently fetched payment status and an explicit owner action.

No matching backend endpoint, encrypted credential vault, owner console or deployment is present in this repository. Providers therefore remain inactive.

## Required owner setup journey

1. Owner signs in to the Aurelia owner-controlled backend console over HTTPS with MFA.
2. Owner chooses exactly one provider and environment (Sandbox/Test or Production).
3. Console displays only that provider's exact credential fields and links to the official dashboard instructions above.
4. Credentials are submitted directly to the backend over TLS, encrypted at rest using a managed key service or equivalent envelope encryption, masked on subsequent views, and never returned to PMS.
5. Backend performs provider-specific credential validation where an official validation endpoint exists. Otherwise it records that validation is pending and requires a sandbox order.
6. Backend provisions the provider's webhook URL and tells the owner exactly which events and signature/authentication method to configure in the provider dashboard.
7. Owner completes one sandbox payment. Backend verifies the callback/webhook cryptographically and independently fetches the final payment status from the provider.
8. Only after all checks pass can the owner enable the provider. Production activation is a separate explicit action after provider live approval and live credentials are entered.
9. PMS receives a non-secret provider status/configuration projection from the backend. Pay Bridge receives only short-lived checkout/session data, never merchant secrets.
10. Refund, void, settlement and reconciliation functions remain disabled until their individual provider adapter operations are implemented and tested.

## Current implementation status (do not misrepresent)

The repository now contains an isolated Razorpay backend reference service under `payment-backend/`:
- Firebase ID token verification with revocation checking, deployment-controlled owner UID allowlist, verified email, MFA second-factor claim and 10-minute recent-authentication gate.
- Provider API and webhook secrets written to Google Secret Manager; non-secret onboarding metadata stored in Firestore.
- Razorpay credential validation against the Orders API.
- Server-side INR test order creation with a Firestore idempotency reservation. Reused or ambiguous requests fail closed rather than dispatching a second order.
- Raw-body HMAC-SHA256 webhook verification, event-ID deduplication, order binding and independent provider payment fetch.
- Separate explicit activation gate. Live activation requires sandbox acceptance and a verified live webhook event.
- Backend security-contract tests included in the Android repository CI workflow.

This is a **reference implementation scaffold, not a deployed production payment backend**. The following remain unimplemented or unverified:
- No owner-controlled Google Cloud project, Cloud Run service, Firestore database, Secret Manager IAM policy, Firebase Identity Platform MFA configuration or DNS/TLS endpoint has been provisioned.
- No browser owner console or MFA enrollment/sign-in UI exists. The service intentionally rejects non-MFA owner tokens.
- The initial deployment allowlist supports configured owner UIDs only; hotel/tenant membership and multi-tenant authorization require a reviewed model before multiple properties are onboarded.
- The Razorpay sandbox flow has not been run against a real merchant test account; provider payload variations, webhook dashboard configuration and test acceptance remain unverified.
- Razorpay checkout handoff, callback signature verification route, reconciliation worker, refunds and PMS/Pay Bridge integration are not implemented.
- The PMS does not yet consume the backend's non-secret provider status projection.
- Cashfree, PayU, PhonePe, Paytm, CCAvenue and JioPay adapters are not implemented.

Do not deploy with broad project Editor permissions. Use a dedicated Cloud Run service identity and least-privilege IAM. Google Secret Manager encrypts secrets at rest and in transit; use secret-level IAM, version pinning, audit logs and rotation as described in the official [Secret Manager best practices](https://docs.cloud.google.com/secret-manager/docs/best-practices). Cloud Run should use a dedicated service identity rather than a downloaded service-account key ([Cloud Run service identity](https://docs.cloud.google.com/run/docs/securing/service-identity)).

The admin API expects Firebase Authentication with Identity Platform MFA. Firebase documents MFA enrollment and sign-in requirements in its [official MFA guide](https://firebase.google.com/docs/auth/web/multi-factor), and the backend follows the [Firebase ID token verification contract](https://firebase.google.com/docs/auth/admin/verify-id-tokens).

Razorpay integration follows its official requirements: create each order on the server, verify checkout signatures server-side using the server-held secret, and independently fetch payment status; see [Razorpay integration steps](https://razorpay.com/docs/payments/payment-gateway/quick-integration/integration-steps/). Webhooks must be verified against the original raw request body, deduplicated by event ID, and supplemented with API fetch for critical status decisions; see [Razorpay webhook validation](https://github.com/razorpay/markdown-docs/blob/master/webhooks/validate-test.md) and [webhook guidance](https://github.com/razorpay/markdown-docs/blob/master/webhooks.md).

**No live payment processing or production activation is authorized by these commits.** A successful build or passing unit tests do not prove a deployed backend, merchant account connection, webhook delivery, or real payment settlement.

## Implementation order

1. Create the owner backend and encrypted merchant credential vault.
2. Implement and test Razorpay sandbox end-to-end as the first reference adapter (create order, checkout handoff, signature verification, webhook verification, status fetch, idempotency, refunds/reconciliation).
3. Build the separate Pay Bridge APK and versioned authenticated IPC operations. Sign PMS and Pay Bridge with the same controlled signing identity; provide a release install/update path.
4. Connect PMS to backend provider status and Pay Bridge only after both sides implement the negotiated capabilities.
5. Add Cashfree, PayU, PhonePe V2, Paytm, CCAvenue one at a time using each provider's current contract; add JioPay only after receiving its merchant-specific docs.
6. Keep auto-folio-settlement disabled. Present verified payment evidence to staff for explicit confirmation.


## Implementation status — 2026-10-31

The backend directory now contains a Razorpay-only reference scaffold with server-resolved tenant membership. Firebase UID is mapped to a platform-provisioned `paymentMemberships/{uid}` record; the APK cannot select or assert its own tenant ID. Provider status, secrets, order idempotency and webhook inbox records are tenant-scoped. The active membership model currently supports one hotel tenant per Firebase UID and owner/admin provider administration only.

This does **not** complete provider onboarding or enable payments. The service is not deployed; Firebase/Firestore/Secret Manager/Cloud Run resources and IAM are not provisioned; no real merchant sandbox has been exercised; the order endpoint is a sandbox test utility, not checkout; reconciliation, refunds, PMS folio posting and Pay Bridge checkout are not integrated. Cashfree, PayU, PhonePe, Paytm, CCAvenue and JioPay adapters remain unimplemented and must stay disabled. Production use is prohibited until the gates in `payment-backend/README.md` are completed and independently reviewed.


## Native credential storage and Pay Bridge boundary

Do **not** implement the sample `PaymentCredentialVault` / `EncryptedSharedPreferences` design for merchant API secrets. The PMS and Pay Bridge are untrusted client processes relative to the payment authority: device encryption at rest does not prevent a compromised/rooted process, runtime instrumentation, memory extraction, debug logging, backups, or intent/Binder inspection from exposing a secret while it is in use. Android Keystore protects key material; it does not turn an APK into a safe merchant-secret authority.

The authoritative store is the owner-controlled backend's tenant-scoped Google Secret Manager records. The PMS owner console may collect a secret transiently and submit it directly over HTTPS with a recently authenticated, MFA-verified Firebase ID token. It must clear the input after submission and never persist the value in IndexedDB, localStorage, SharedPreferences, WebView storage, logs, analytics, crash reports, source code or an APK. The backend returns status metadata only, never the secret.

The Pay Bridge must receive only a short-lived, provider-issued checkout/session token or other narrowly scoped non-secret checkout parameters returned by the backend. It must never receive Razorpay Key Secret, Cashfree Secret Key, PhonePe Client Secret, PayU Salt, Paytm Merchant Key, CCAvenue Working Key, webhook secrets, or a backend service credential through an Intent, Bundle, Messenger, Binder, file, or local preference. The server performs provider API authentication and webhook verification.

A local encrypted vault is appropriate only for app-owned local secrets that genuinely must remain on-device; it is not a substitute for this server-side merchant credential boundary. No native merchant credential vault or credential-to-IPC injection path is part of the current PMS payment contract.
