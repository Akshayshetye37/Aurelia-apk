# Aurelia PMS — Seven-provider integration status

**Architecture:** Hybrid production backend (see [HYBRID_PAYMENT_ARCHITECTURE.md](./HYBRID_PAYMENT_ARCHITECTURE.md)).  
**Release status:** All live payment collection OFF. No provider is declared production-ready by this document.

| Provider | Current repository implementation | Required work before enablement |
|---|---|---|
| Razorpay | Backend adapter exists in `payment-backend/src/providers/razorpay.mjs`; cloud repository currently allows it | Review API version and webhook event coverage; verify refund status/idempotency; add contract/fault tests; complete accounting and UAT |
| Cashfree | Backend adapter exists in `payment-backend/src/providers/cashfree.mjs`; cloud repository currently allows it | Review API version, amount representation, webhook/status matching and refund idempotency; add contract/fault tests; complete accounting and UAT |
| PayU | No adapter found in selected branch | Implement chosen PayU product (Hosted Checkout or supported S2S); exact hash/auth algorithms; verify-payment API; webhooks; refund/status; sandbox tests |
| PhonePe | No adapter found in selected branch | Implement Standard Checkout product and current auth/token flow; order status; webhook verification; refund/status; UAT |
| Paytm | No adapter found in selected branch | Implement Initiate Transaction, checksum/signature, Transaction Status, refund and refund-status; webhook verification; staging tests |
| JioPay | No adapter found in selected branch | Obtain merchant-specific API credentials/product spec; implement payment initiation, secureHash, status/refund commands and callbacks; UAT |
| CCAvenue | No adapter found in selected branch | Confirm enabled merchant integration product and current integration kit; implement hosted checkout request/response encryption/decryption, status and refund workflow; sandbox tests |

## Official documentation entry points

- **Razorpay:** [Orders API](https://razorpay.com/docs/api/orders/), [Standard Checkout](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/), [Webhooks](https://razorpay.com/docs/webhooks/), [Refunds](https://razorpay.com/docs/api/refunds/).
- **Cashfree:** [Payment Gateway API](https://www.cashfree.com/docs/api-reference/payments/latest/overview), [Webhooks](https://www.cashfree.com/docs/payments/online/webhooks), [Refunds](https://www.cashfree.com/docs/api-reference/payments/latest/refunds/create).
- **PayU:** [India API Reference v2](https://docs.payu.in/v2/reference/introduction-api-reference), [Verify Payment](https://docs.payu.in/reference/verify_payment_api), [Webhooks](https://docs.payu.in/docs/webhook-events-and-sample-payloads), [Refund API](https://docs.payu.in/reference/refund_transaction_api).
- **PhonePe:** [Developer portal](https://developer.phonepe.com/), [Standard Checkout](https://developer.phonepe.com/phonepe-payment-gateway/pg-v2-standard-checkout-integration).
- **Paytm:** [Server SDKs](https://www.paytmpayments.com/docs/server-sdk/), [Initiate Transaction API](https://www.paytmpayments.com/docs/api/initiate-transaction-api/), [Callback and Webhooks](https://business.paytm.com/docs/callback-and-webhook/).
- **JioPay:** [Payments documentation](https://docs.jiopay.in/docs/payments), [Status / Refund command](https://docs.jiopay.in/reference/command), [Refund API](https://docs.jiopay.in/docs/refund-api).
- **CCAvenue:** [Official services and integration FAQ](https://www.ccavenue.com/services). Merchant-specific integration kit and current API contract must be obtained from the activated CCAvenue merchant account before implementation is enabled.

## Enablement rule

A provider can move from `DOCUMENTATION_ONLY` to `SANDBOX_IMPLEMENTED` only after its adapter implements all advertised operations and automated contract tests pass. It can move to `LIVE_ELIGIBLE` only after merchant UAT, provider approval, security review, webhook reachability, refund/reconciliation and folio acceptance are signed off. UI labels must be derived from backend capability state, not hard-coded claims.
