# Aurelia payment-provider integration research

Research snapshot: 30 October 2026  
Scope: Razorpay, Paytm Payment Gateway and PhonePe Payment Gateway. This is an implementation specification distilled from provider documentation, not a claim that live merchant integrations are already connected.

## Shared Aurelia architecture

1. PMS creates a folio collection intent with an immutable Aurelia booking/folio reference and amount in INR paise.
2. Pay Bridge is the authenticated Android IPC client between PMS and provider-facing app workflows. It is not the payment authority and must not hold merchant secrets.
3. The Aurelia trusted backend creates provider orders/transactions, stores credentials, receives callbacks/webhooks, verifies signatures/checksums, queries provider status, and writes an idempotent provider-event ledger.
4. Backend returns a signed/authorized settlement decision to PMS. PMS checks Pay Bridge identity, booking/folio, amount, currency, provider transaction ID and idempotency key before it invokes the single settlement mutation boundary.
5. Pending, failed, refunded, disputed, ambiguous, duplicate or mismatched events never auto-settle. Webhook retries and polling must be idempotent.
6. Auto-settlement remains disabled until the provider integration, backend, Pay Bridge and PMS have passed sandbox and live end-to-end tests.

## Razorpay — first implementation target

Official docs:
- [Standard Checkout integration steps](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/)
- [Webhooks](https://razorpay.com/docs/webhooks/)
- [Orders API](https://razorpay.com/docs/api/orders/)

Integration facts:
- Create an Order server-side for every payment. Amount is expressed in the smallest currency unit (INR paise).
- Pass the server-created order_id into Checkout; do not trust a client-supplied order ID as the source of truth.
- Verify the Checkout response signature server-side using the server-stored key secret and the order ID originally stored by Aurelia.
- Verify webhook signatures server-side using the raw request body and webhook secret.
- Confirm captured payment status (via verified webhook and/or provider status API) before considering a payment eligible for settlement. Authorized is not the same as captured.
- Treat webhook deliveries as at-least-once: persist event IDs and payment IDs with uniqueness constraints and safely handle retries/out-of-order events.

Aurelia adapter contract:
- createOrder(folioIntent) — backend only.
- verifyCheckoutResponse(orderId, paymentId, signature) — backend only.
- verifyWebhook(rawBody, signatureHeader) — backend only.
- fetchPaymentStatus(paymentId) — backend only.
- normalizeVerifiedPayment(...) — produce a provider-neutral event only after verification.

## Paytm Payment Gateway

Official docs:
- [Initiate Transaction API](https://www.paytmpayments.com/docs/api/initiate-transaction-api)
- [Payment Status](https://www.paytmpayments.com/docs/payment-status)
- [Callback and Webhook](https://www.paytmpayments.com/docs/callback-and-webhook)

Integration facts:
- Initiate the transaction from the merchant backend; Paytm returns a transaction token used by the checkout flow.
- Generate and validate the required checksum/signature on the backend. Merchant keys/salts never enter PMS or Pay Bridge.
- Callback and webhook responses can be intermediate or final. Verify CHECKSUMHASH and then confirm final state through the Transaction Status API.
- Accept only a final successful status (TXN_SUCCESS) for the expected MID, merchant order ID, amount and currency.
- Handle webhook delivery retries and duplicate notifications with idempotent event processing.

Aurelia adapter contract:
- initiateTransaction(folioIntent) — backend only.
- verifyCallbackOrWebhook(payload) — backend only.
- fetchTransactionStatus(orderId) — backend only.
- normalizeVerifiedPayment(...) — only after final status and order/amount checks.

## PhonePe Payment Gateway

Official docs:
- [PhonePe PG Developer Portal](https://developer.phonepe.com)
- [Standard Checkout V2](https://developer.phonepe.com/phonepe-payment-gateway/pg-v2-standard-checkout-integration)
- [PhonePe-maintained PG documentation index](https://github.com/PhonePe/phonepe-pg-docs-mcp)

Integration facts:
- Use the current Standard Checkout V2 contract and the merchant's enabled environment/credentials; do not copy legacy V1 examples into a V2 adapter.
- Create the merchant order and initiate checkout from the backend; return only the required checkout/redirect data to the client.
- Verify server-to-server webhook/callback authenticity using the signature mechanism specified by the merchant's current PhonePe API version.
- Independently query the order status through the current status API. A browser redirect or client success screen is not proof of payment.
- Verify merchant order reference, amount, currency and terminal success state. Deduplicate events and poll status when callbacks are delayed or missing.

Aurelia adapter contract:
- createStandardCheckoutOrder(folioIntent) — backend only.
- verifyWebhook(rawBody, headers) — backend only, version-specific.
- fetchOrderStatus(merchantOrderId) — backend only.
- normalizeVerifiedPayment(...) — only after provider status confirmation.

## Pay Bridge and PMS boundaries

- Pay Bridge: app identity, authenticated IPC, provider-workflow handoff and connection lifecycle.
- PMS: folio context, guest/booking selection, payment display and final display of backend-authorized settlement result.
- Trusted backend: merchant credentials, order creation, signature/checksum validation, provider status polling, webhook ingestion, idempotency, audit ledger and settlement authorization.
- Never embed key secrets, salts, webhook secrets, private keys or API access tokens in APK assets, local storage, source code or logs.
- A provider being configured in PMS is not equivalent to a verified provider connection.
- A connected Pay Bridge is not equivalent to a provider payment being successful.

## Rollout gates

1. Provider-specific sandbox tests: success, failure, pending, timeout, duplicate webhook, out-of-order webhook, refund and amount mismatch.
2. Backend security tests: signature/checksum tampering, replay, wrong MID/client, wrong order ID, wrong amount and credential leakage.
3. Pay Bridge tests: package/signature verification, handshake, reconnect, disconnect, stale session and malformed IPC payloads.
4. PMS tests: correct folio mapping, partial payment, overpayment rejection, cross-booking duplicate UTR/payment ID, persistence rollback and audit trail.
5. Live low-value pilot with automatic settlement still disabled; compare provider ledger, backend ledger and PMS folio.
6. Enable automatic settlement only after explicit release approval and all gates pass.

## Current implementation status

- PMS provider settings screen: exists; it stores only public merchant identifiers and an HTTPS backend URL.
- Provider-specific research and setup guidance: embedded in the provider workspace in PMS.
- Provider API adapters/backend endpoints: not implemented by this change.
- Separate Aurelia Pay Bridge APK: not yet built.
- Live merchant credentials/webhooks: not connected.
- Automatic folio settlement: disabled.
