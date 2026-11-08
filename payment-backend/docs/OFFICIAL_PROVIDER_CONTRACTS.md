# Official payment-provider integration contracts (research baseline)

Research date: 2026-11-06. This document records the official public documentation reviewed for the seven gateways already named by Aurelia. It is a source-of-truth checklist, not a claim that adapters are implemented or merchant credentials are enabled.

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

- The Aurelia adapter selects the **classic PayU India hosted-checkout contract**; it does not mix the V2 HMAC authorization contract into classic requests.
- Hosted checkout posts to `https://test.payu.in/_payment` or `https://secure.payu.in/_payment` with the classic SHA-512 request hash generated from the key/txnid/amount/product/customer/udf/salt sequence.
- Payment verification and refund commands use the classic `merchant/postservice.php?form=2` interface and command hash `key|command|var1|salt`.
- Refund initiation uses `cancel_refund_transaction` with PayU ID as `var1`, merchant refund token as `var2`, and decimal refund amount as `var3`; refund status is queried by request ID or PayU ID.
- Merchant account UAT is still required to validate command response shapes, refund request IDs, callback reverse hash and account-specific permissions.

### PhonePe Payment Gateway
Official developer portal: https://developer.phonepe.com/
Standard Checkout V2: https://developer.phonepe.com/phonepe-payment-gateway/pg-v2-standard-checkout-integration

- The Aurelia adapter targets Standard Checkout V2: sandbox `https://api-preprod.phonepe.com/apis/pg-sandbox`, production `https://api.phonepe.com/apis/pg`, with the production OAuth token endpoint under `/apis/identity-manager/v1/oauth/token`.
- Token expiry uses the provider `expires_at` epoch where returned; the bearer token is sent as `O-Bearer`.
- Webhook authorization is verified against the configured SHA-256 digest of `username:password` using constant-time comparison; raw event JSON is parsed only after authentication.
- Refund initiation and refund-status are separate provider calls; refund status must bind to the original merchant order and amount.
- Client ID, client secret, client version and webhook credentials still require merchant sandbox/UAT confirmation; never treat redirect return as final payment confirmation.

### Paytm Payment Gateway
Official docs: https://business.paytm.com/docs/
Callback/webhook: https://business.paytm.com/docs/callback-and-webhook/
Server SDK API operations: https://business.paytm.com/docs/server-sdk/php/

- Initiate Transaction returns a transaction token used by the client checkout flow; the adapter uses the official `paytmchecksum` Node package rather than a simplified HMAC substitute.
- Query Transaction Status server-side before fulfillment and bind the response MID/order ID to the local intent.
- Verify callbacks using the official checksum implementation over the callback fields.
- Refund initiation (`/refund/apply`) and refund status (`/v2/refund/status`) are separate operations; accepted refunds remain pending until the refund-specific credit state is terminal.
- Use staging and production gateway hosts and credentials separately; merchant staging/UAT is still required.

### CCAvenue
Official merchant technical FAQ: https://www.ccavenue.com/faq  
Published Merchant API v1.3 guide: https://links.avenues.info/downloads/CCAvenues_API_Vers-1_3.pdf  
Merchant activation and integration-kit process: https://www.ccavenue.com/compliance

- The published Merchant API v1.3 guide documents `orderStatusTracker`, encrypted API requests/responses, staging and production API hosts, and requires the merchant's public egress IP to be registered with CCAvenue.
- The guide says encryption must follow the real-time transaction integration kit, but does not specify the complete key derivation, IV, padding, callback authentication or general refund contract needed to implement safely.
- Its documented `splitRefund` is specifically for split-payout transactions and is limited to one refund; it is not a general refund lifecycle.
- CCAvenue remains catalogue-only and is intentionally not factory-wired. Do not guess encryption parameters, treat encrypted callbacks as authenticated webhooks, or map split refunds to ordinary refunds.
- Obtain the current merchant-specific integration kit and API entitlement, record its version, registered egress IP, callback specification and refund capability, then implement against that exact contract. Keep access code and working key in Secret Manager.

### Jio Payment Solutions Limited (JioPay)
Official docs: https://docs.jiopay.in/
Base integration: https://docs.jiopay.in/docs/base-integration
Hash guide: https://docs.jiopay.in/docs/generate-hash
Callbacks: https://docs.jiopay.in/docs/webhooks
Status/refund command: https://docs.jiopay.in/reference/command

- UAT base: `https://uat.jiopay.co.in/`; production base: `https://jiopay.co.in/`.
- Requests and responses use merchant-secret HMAC-SHA256 `secureHash`: sort parameter keys alphabetically, concatenate parameter values without delimiters, then HMAC-SHA256 the message and encode lowercase hex. Null response values must follow the provider's exact string canonicalization.
- Hosted checkout uses `/pg/api/v2/initiateSale` (UAT `/tsp/pg/api/v2/initiateSale`), `currencyCode: 356`, `payType: 0`, a 20-character maximum merchant transaction reference and a valid customer email (use the documented guest address when unavailable).
- The command API uses `/pg/api/command` (UAT `/tsp/pg/api/command`) with `STATUS` and `REFUND`; for STATUS, `merchantTxnNo` is the same as `originalTxnNo`.
- Server-to-server callbacks are recommended, but must be hash-verified and reconciled against the status API. Published callback/status examples use `merchantTxnNo`, `txnID`, and (for status) `txnStatus: SUC`; the status example omits `currencyCode`. Aurelia therefore binds the webhook/payment lookup to `txnID` first and normalizes a missing currency to INR only because this adapter accepts and submits INR (currencyCode `356`) exclusively. An explicit non-INR currency is rejected. Merchant/aggregator configuration and UAT are still required.
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
