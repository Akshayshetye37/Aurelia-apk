# Aurelia PMS — Seven-provider integration status

**Architecture:** Hybrid production backend (see [HYBRID_PAYMENT_ARCHITECTURE.md](./HYBRID_PAYMENT_ARCHITECTURE.md)).  
**Execution plan:** [Dependency-ordered payment implementation plan](./PAYMENT_IMPLEMENTATION_PLAN.md).  
**Release status:** All live payment collection OFF. No provider is declared production-ready.

| Provider | Adapter status | Lifecycle gaps / gate |
|---|---|---|
| Razorpay | Adapter exists; partial backend integration | Complete reference lifecycle: durable webhook inbox/deduplication, authoritative status reconciliation, refund-status lookup/idempotency, failure recovery, folio settlement and contract tests |
| Cashfree | Adapter exists; partial backend integration | Complete reference lifecycle: versioned webhook/status matching, durable deduplication, refund-status/idempotency, failure recovery, folio settlement and contract tests |
| PayU | Missing — not registered as working | Select exact India Hosted Checkout or S2S product/API version; implement hash/auth, verify-payment, webhook, refund/status and sandbox contract |
| PhonePe | Missing — not registered as working | Confirm merchant Standard Checkout product/API version; implement token lifecycle, order/status, callback verification, refund/status and UAT |
| Paytm | Missing — not registered as working | Confirm merchant PG product; implement checksum/signature, initiate/status, callback verification, refund/status and staging tests |
| JioPay | Missing — not registered as working | Obtain merchant-specific API pack; implement secureHash, initiation, status/refund command and callback verification |
| CCAvenue | Missing — not registered as working | Obtain merchant-specific integration kit/API version; implement request encryption, response decryption, status/refund workflow and callback validation |

## Delivery sequence

1. Harden and verify cloud runtime; wire the authenticated Android API client to the app's actual Firebase session provider.
2. Complete Razorpay and Cashfree as reference implementations against one shared lifecycle contract.
3. Implement PayU, PhonePe, Paytm, JioPay and CCAvenue as independent adapters. Share utilities, never provider signing or callback assumptions.
4. Complete webhook inbox, refunds, reconciliation, transactional outbox and canonical PMS folio settlement.
5. Run sandbox, end-to-end, duplicate-event, timeout, outage, process-death and recovery tests. Obtain provider UAT evidence before any live eligibility decision.

## Official documentation entry points

- **Razorpay:** [Orders API](https://razorpay.com/docs/api/orders/), [Standard Checkout](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/), [Webhooks](https://razorpay.com/docs/webhooks/), [Refunds](https://razorpay.com/docs/api/refunds/).
- **Cashfree:** [Payment Gateway API](https://www.cashfree.com/docs/api-reference/payments/latest/overview), [Webhooks](https://www.cashfree.com/docs/payments/online/webhooks), [Refunds](https://www.cashfree.com/docs/api-reference/payments/latest/refunds/create).
- **PayU:** [India API Reference v2](https://docs.payu.in/v2/reference/introduction-api-reference), [Verify Payment](https://docs.payu.in/reference/verify_payment_api), [Webhooks](https://docs.payu.in/docs/webhook-events-and-sample-payloads), [Refund API](https://docs.payu.in/reference/refund_transaction_api).
- **PhonePe:** [Developer portal](https://developer.phonepe.com/), [Standard Checkout](https://developer.phonepe.com/phonepe-payment-gateway/pg-v2-standard-checkout-integration).
- **Paytm:** [Server SDKs](https://www.paytmpayments.com/docs/server-sdk/), [Initiate Transaction API](https://www.paytmpayments.com/docs/api/initiate-transaction-api/), [Callback and Webhooks](https://business.paytm.com/docs/callback-and-webhook/).
- **JioPay:** [Payments documentation](https://docs.jiopay.in/docs/payments), [Status / Refund command](https://docs.jiopay.in/reference/command), [Refund API](https://docs.jiopay.in/docs/refund-api).
- **CCAvenue:** [Official services and integration FAQ](https://www.ccavenue.com/services). Merchant-specific integration kit and current API contract must be obtained from the activated CCAvenue merchant account before implementation is enabled.

## Enablement rule

A provider can move from `DOCUMENTATION_ONLY` to `ADAPTER_IN_PROGRESS` to `SANDBOX_VERIFIED` only as its code and evidence justify. It can move to `LIVE_ELIGIBLE` only after merchant UAT, provider approval, security review, webhook reachability, refund/reconciliation and folio acceptance are signed off. UI labels must be derived from backend capability state, not hard-coded claims.
