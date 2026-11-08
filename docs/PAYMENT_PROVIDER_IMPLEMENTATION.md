# Payment provider implementation and release status

This document describes the six provider adapters currently wired into Aurelia's payment backend. Adapter implementation is not the same as merchant qualification or approval to collect live funds.

## Wired adapters

All six adapters implement the lifecycle contract in `src/providers/adapter-contract.mjs`:

- credential validation
- order creation
- order lookup by merchant reference
- authoritative payment-status lookup
- webhook signature verification
- refund creation
- refund-status lookup

| Provider | Environments | Checkout flow | Authentication / integrity |
|---|---|---|---|
| Razorpay | test / live | Orders API; client uses returned Key ID and Order ID | HTTP Basic API auth; HMAC-SHA256 webhook over raw bytes; `X-Refund-Idempotency` on refund calls |
| Cashfree | test / live | PG Orders API; client uses payment session ID | Client ID/secret; HMAC-SHA256 webhook over timestamp + raw body; stable idempotency UUID |
| PayU | test / live | Hosted `/_payment` form with SHA-512 request hash | SHA-512 command and callback hashes; `verify_payment` and `check_action_status_txnid` reconciliation |
| PhonePe | test / live | Standard Checkout V2 | OAuth client credentials; O-Bearer API token; webhook SHA-256 authorization derived from configured username/password |
| Paytm | staging / production | Initiate Transaction API and transaction token | Signed request and response checksum; server-side transaction-status and refund-status calls |
| JioPay | UAT / production | Hosted `initiateSale` | HMAC-SHA256 over alphabetically sorted parameter values concatenated without delimiters; signed response validation |

## Reliability and financial controls

- Provider calls that can create a payment or refund expose `outcomeUnknown` when a transport failure or retryable server error means the provider may have processed the request. Callers must reconcile using the stable merchant reference before retrying. Do not create a new order/refund identity to work around an ambiguous response.
- Every returned payment/refund identity is checked against the merchant order, payment, refund, amount and currency supplied by Aurelia where the provider returns those fields.
- Payment capture is based on provider-side status evidence, not a browser redirect or mobile SDK callback.
- Refunds are reserved against the captured amount in the local intent. A refund is not marked successful unless the provider reports a successful state and an exact matching INR amount.
- Provider webhook verification authenticates the raw request. Durable event deduplication and state-transition enforcement remain application responsibilities.
- Merchant secrets must be stored in Secret Manager. Do not place API keys, salts, webhook secrets or JioPay hash keys in source control, client bundles or logs.

## Qualification status

The adapters are implemented and registered, but **none is production-qualified by this code change**. Before a provider can collect live funds, the merchant account must pass provider sandbox/UAT, webhook delivery and replay checks, real refund lifecycle tests, physical-device checkout acceptance, credential validation, and canonical folio/journal posting approval.

The production collection, automatic settlement and automatic refund-posting controls remain disabled. Account 2020 accounting treatment and authorization of the canonical journal writer remain separate finance decisions.

## CCAvenue

CCAvenue remains catalogue-only and is deliberately not registered in the adapter factory. The current code contains only the verified Mobile SDK request-hash helper. A complete adapter still requires the merchant-issued Tracking ID Generation API package, its exact encryption/decryption implementation and known-answer vectors, and the actual SDK artifact/API package. The classic hosted-web checkout protocol must not be mixed with the Mobile SDK protocol. No undocumented Android activity or speculative AES key/IV derivation is included.
