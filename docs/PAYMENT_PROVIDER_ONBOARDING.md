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

## Current implementation gap (do not misrepresent)

The repository currently contains:
- A PMS-side Messenger client and protocol-v1 handshake contract.
- A provider catalogue and official documentation links.
- A local PMS preference validation helper.

The repository does **not** yet contain:
- The separate `com.aurelia.paybridge` Android application/service APK.
- A production owner backend, merchant credential vault, provider APIs, webhook endpoints or deployment configuration.
- Live provider adapters for the seven catalogue entries.
- A provider-management IPC implementation advertising `provider.management`.

Therefore, the present Connect action cannot authenticate a missing Pay Bridge APK, and the provider form cannot truthfully activate a gateway. The CodeShack browser preview cannot exercise Android Messenger IPC at all. The PMS debug APK build passing is not proof of a working payment integration.

## Implementation order

1. Create the owner backend and encrypted merchant credential vault.
2. Implement and test Razorpay sandbox end-to-end as the first reference adapter (create order, checkout handoff, signature verification, webhook verification, status fetch, idempotency, refunds/reconciliation).
3. Build the separate Pay Bridge APK and versioned authenticated IPC operations. Sign PMS and Pay Bridge with the same controlled signing identity; provide a release install/update path.
4. Connect PMS to backend provider status and Pay Bridge only after both sides implement the negotiated capabilities.
5. Add Cashfree, PayU, PhonePe V2, Paytm, CCAvenue one at a time using each provider's current contract; add JioPay only after receiving its merchant-specific docs.
6. Keep auto-folio-settlement disabled. Present verified payment evidence to staff for explicit confirmation.
