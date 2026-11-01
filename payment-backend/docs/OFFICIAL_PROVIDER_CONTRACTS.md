# Official payment-provider integration contracts (research baseline)

Research date: 2026-11-01. This document records the official public documentation reviewed for the seven gateways already named by Aurelia. It is a source-of-truth checklist, not a claim that adapters are implemented or merchant credentials are enabled.

## Shared Aurelia contract

Every adapter must implement, at minimum:

- credential validation using a non-mutating authenticated API call where supported;
- create hosted checkout/order (never collect PAN/CVV in Aurelia);
- fetch authoritative payment status from the provider server-to-server;
- verify provider webhook authenticity using the exact raw bytes or documented signature canonicalization;
- create and query refunds with idempotency and provider refund identifiers;
- map provider states to a conservative internal state machine;
- persist provider request/response metadata with secrets and payment instrument data redacted;
- support timeout/unknown outcomes and reconciliation without blindly retrying a potentially successful create/refund.

A browser return/callback is not proof of payment. A payment is eligible for folio posting only after server-side status verification, exact amount/currency/order/tenant binding, and an atomic idempotent folio transaction. Webhooks are hints to reconcile, not authority by themselves.

## Provider documentation and implementation notes

### Razorpay
Official API: https://razorpay.com/docs/api/
Security checklist: https://razorpay.com/security/checklist

- REST API base commonly `https://api.razorpay.com/v1`; Basic authentication uses Key ID and Key Secret.
- Test and Live API keys are distinct.
- Create Order, then use hosted/SDK checkout; verify checkout signature and fetch payment server-side.
- Webhooks must be HMAC-verified over the raw request body.
- Keep API secret out of mobile binaries and version control.
- Adapter must cover order, payment fetch/capture as configured, refund and refund-status/reconciliation.

### Cashfree Payments
Official API portal: https://www.cashfree.com/docs/
Official checkout walkthrough: https://www.cashfree.com/devstudio/preview/pg/web/popupCheckout

- Server creates an order; response includes a payment_session_id consumed by the client checkout SDK.
- Fetch all payments for an order after checkout and trust the provider-side final state, not the client callback.
- Configure notify URL/webhook when creating orders; verify webhook signatures using the provider's documented raw-body/timestamp procedure.
- API version and environment must be explicit configuration, not guessed. App ID and Secret Key are environment-specific.
- Implement refunds and refund-status using the current Payments API version.

### PayU India
Official developer portal: https://docs.payu.in/
V2 API reference: https://docs.payu.in/v2/reference/introduction-api-reference
Classic integration API map: https://docs.payu.in/docs/apis-used-for-merchant-integration

- PayU exposes distinct V2 and classic hosted-checkout contracts. Do not combine their authentication, payloads or hash algorithms.
- V2 documentation includes hosted checkout, verify payment, webhooks, create refund and refund status.
- Classic hosted checkout uses a mode-specific SHA-512 request hash; post-service APIs use the documented key/command/var1/salt sequence.
- Select one contract per merchant account during onboarding; implement its exact test/live endpoints and hash canonicalization.
- Refund sandbox availability is feature-dependent; do not equate a successful mock/reference call with sandbox certification.

### PhonePe Payment Gateway
Official developer portal: https://developer.phonepe.com/
Standard Checkout V2: https://developer.phonepe.com/phonepe-payment-gateway/pg-v2-standard-checkout-integration

- Use the merchant's enabled PhonePe PG product and its current Standard Checkout V2 contract.
- Implement OAuth/token acquisition, payment creation, status fetch, webhook/callback verification and refund/status according to the merchant's enabled API version.
- Client ID, client secret, client version and merchant ID are not sufficient evidence of a valid integration; verify the exact onboarding-issued values and API version.
- Never treat redirect return as final payment confirmation.

### Paytm Payment Gateway
Official docs: https://business.paytm.com/docs/
Callback/webhook: https://business.paytm.com/docs/callback-and-webhook/
Server SDK API operations: https://business.paytm.com/docs/server-sdk/php/

- Initiate Transaction returns a transaction token used by the client payment flow.
- Query Transaction Status server-side before fulfillment.
- Sign requests and verify callbacks/webhooks with the official Paytm checksum library/algorithm for the selected API.
- Refund initiation and refund-status are separate operations; model asynchronous refund states.
- Use staging and production gateway hosts and credentials separately.

### CCAvenue
Official merchant site and technical FAQ: https://www.ccavenue.com/faq

- CCAvenue merchant integrations are product/account-specific; merchant ID, access code and working key alone do not fully define the integration contract.
- Public documentation available in this research pass did not expose a current, authoritative API reference for checkout encryption/decryption, status and refund endpoints.
- Do not implement guessed encryption, endpoints, field names or signature rules. Obtain the current CCAvenue integration kit/specification from the merchant dashboard or CCAvenue onboarding/support, record its version, then implement and test that exact contract.
- Keep access code and working key in Secret Manager. Validate encrypted response integrity and independently query transaction status before folio posting.

### Jio Payment Solutions Limited (JioPay)
Official docs: https://docs.jiopay.in/
Base integration: https://docs.jiopay.in/docs/base-integration
Hash guide: https://docs.jiopay.in/docs/generate-hash
Callbacks: https://docs.jiopay.in/docs/webhooks
Status/refund command: https://docs.jiopay.in/reference/command

- UAT base: `https://uat.jiopay.co.in/`; production base: `https://jiopay.co.in/`.
- Requests and responses use a merchant secret-based SHA-256/HMAC secureHash. The documented canonicalization sorts parameter keys and concatenates values; follow the exact product-specific page and verify response hashes.
- Server-to-server callbacks are recommended as the definitive notification path; still reconcile with the status API.
- The status/refund command supports STATUS and REFUND with merchant transaction references and amount.
- Hosted checkout, QR/intent and seamless flows are distinct. Do not implement a card-data seamless flow unless the merchant has the required PCI-DSS certification and explicitly enabled product.

## Deployment gates

A Cloud Run deployment is not payment-ready until all are true:

1. Google Cloud project, Firebase Auth MFA, Firestore, Secret Manager and Cloud Run are provisioned.
2. Service account has least-privilege Secret Manager access and Firestore access; no service-account key is stored in GitHub.
3. Firestore Security Rules deny mobile clients writes to memberships, provider configs, payment orders, webhook inboxes and folios.
4. Membership provisioning is performed by a trusted administrative process; a client cannot self-assign tenant/role.
5. Exact HTTPS owner origins, custom domain, TLS, rate limits, request limits, audit trail, monitoring and alerting are configured.
6. All seven adapters have deterministic unit/contract tests and provider sandbox evidence for create, success, failure, pending, duplicate/out-of-order webhook, status reconciliation and refund.
7. PMS and Pay Bridge integration tests prove the same payment intent/order identity, amount/currency/tenant binding, replay protection and atomic folio posting.
8. Production activation is per tenant and environment, blocked until sandbox acceptance and live webhook verification.

## Explicit non-goals

- No PAN/CVV collection or storage by Aurelia.
- No credentials embedded in APKs, web frontend bundles or Git.
- No client callback or unsigned webhook used as proof of payment.
- No automatic retry after ambiguous create/refund network outcomes.
- No claim of provider support before the exact merchant product/API version has passed sandbox contract tests.
