# Aurelia PMS — All-provider production hardening review

**Review date:** 8 November 2026  
**Branch:** `feature/phase-7-pms-persistence`  
**Scope:** All six factory-wired providers plus the separate CCAvenue foundation.  
**Decision:** Retain the existing provider-adapter architecture. The shared payment trust boundary is substantially implemented; merchant qualification, canonical accounting, operational reconciliation and Android acceptance remain release blockers. This review does not authorize live collection.

## 1. Executive result

The Saigon Technology payment-gateway development guidance emphasizes provider orchestration, server-side trust, idempotency, authenticated webhooks, payment-state separation, refunds and settlement reconciliation. Aurelia already has substantial foundations for these controls:

- Six adapters are registered and must implement all seven lifecycle operations.
- The backend creates provider orders from persisted payment-intent values and checks provider-returned order/payment identity, amount and currency before treating a payment as captured.
- The production webhook route verifies the provider-specific signature, fetches authoritative provider status, compares order/payment/amount/currency to the persisted provider-order binding, and stores a tenant/provider/environment-scoped event inbox record in a Firestore transaction.
- Webhook evidence does not itself authorize accounting. Settlement commands remain gated by payment controls, trusted-device evidence and a separate settlement authority.
- Refund creation and refund-status lookup exist in all six adapters; these are provider operations, not proof that refund-to-folio posting is enabled.
- Production qualification is evidence-based and fail-closed. Every provider remains unqualified until all required evidence is approved and current.

**No provider is production-ready.** Mocked adapter tests establish deterministic contract behavior, not merchant-account interoperability, bank settlement, Android device acceptance or production operations.

## 2. Provider-by-provider assessment

| Provider | Checkout / order identity | Authoritative status | Webhook authentication | Refund lifecycle | Main qualification boundary |
|---|---|---|---|---|---|
| **Razorpay** | Server-created Orders API order; merchant receipt is retained for recovery and lookup. Key ID may be returned for client SDK initialization; Key Secret remains backend-only. | Payment/order API lookup; captured state is distinct from authorization. Server compares provider order, payment, amount and INR currency with the persisted intent. | HMAC-SHA256 over the exact raw body using webhook secret; constant-time comparison. Provider event ID is used for inbox identity. | Refund create and status lookup; stable refund idempotency header is used for retries. | Merchant UAT, Android SDK version/build/device tests, webhook redelivery, refund drills and settlement/folio parity. |
| **Cashfree** | Backend creates order using persisted merchant order ID and integer paise converted to decimal INR. Stable intent idempotency key is mapped to the provider idempotency header. | Order plus payment-list lookup; only a matching successful payment with valid amount and INR is treated as captured. | Timestamped HMAC-SHA256 using the configured webhook key and exact raw body; timestamp freshness is checked before acceptance. | Refund create/status; merchant refund ID and provider refund/payment/order bindings are checked; stable idempotency key is used. | Confirm configured API version and webhook retry/timestamp behavior with the merchant account; complete UAT, Android acceptance and settlement/folio parity. |
| **PayU** | Classic hosted POST checkout; transaction ID and payment hash are generated server-side. No salt is exposed to Android. | Classic Verify Payment command; only `success` plus `captured` maps to captured. | Reverse SHA-512 response hash; merchant key and transaction reference are checked. Raw form/JSON bytes are retained until verification. | `cancel_refund_transaction` plus refund status commands; merchant refund token and provider request ID are retained. | Confirm classic product/account contract, refund status semantics, callback formats, merchant UAT and WebView/device acceptance. Ambiguous refund outcomes must be status-checked before retry. |
| **PhonePe** | Standard Checkout V2 OAuth; persisted merchant order ID and integer paise are sent to the backend API; client receives HTTPS checkout URL. | Checkout V2 order status; completed state must bind to a completed payment detail and valid amount. | PhonePe webhook Authorization digest is checked in constant time against configured webhook username/password; event payload must include merchant order identity. | Refund create/status; merchant refund ID, original merchant order ID and amount are checked. | Confirm production OAuth/API host, webhook credentials and event schema with merchant account; UAT, device acceptance and refund/settlement drills. |
| **Paytm** | Backend Initiate Transaction API creates the transaction token using a signed request; callback URL is persisted and passed through the checkout contract. | Signed Transaction Status API; MID, order ID, status and amount are checked. | Paytm checksum is verified using the merchant key; MID and order identity are checked. | Refund apply/status APIs; MID, order, refund reference and payment identity are checked. | Merchant staging/UAT, callback and token acceptance, SDK/R8/device tests, pending-refund recovery and settlement/folio parity. |
| **JioPay** | Hosted checkout initiation uses a signed request and validates the signed redirect response, merchant ID, merchant transaction number and transaction context. | Signed STATUS command; merchant ID/order reference, status, amount and INR currency are checked. | HMAC-SHA256 secureHash over the provider-defined canonical fields; constant-time comparison and merchant/order binding. | Signed REFUND and STATUS commands; merchant refund reference, original order and amount are checked. | Confirm merchant/aggregator-specific hash vectors, production endpoint and callback schema, UAT, refund recovery and settlement/folio parity. |
| **CCAvenue** | **Not registered as a provider adapter.** Existing hosted-checkout/crypto/status/notification modules are isolated foundations only. | Partial Merchant API status verification exists, but the complete adapter contract is not qualified. | Merchant-specific notification authentication and AES interoperability remain unresolved. | A general refund lifecycle is not established; a limited split-refund capability is not a substitute. | Do not enable or register until the merchant kit, AES vectors, callback authentication, egress registration, Android integration and general refund contract are verified. |

### Provider-specific retry rules

Provider idempotency is not interchangeable. Aurelia must persist its own immutable operation identity and request parameters before sending a mutating call. The adapter-specific provider reference/header is an additional protection, not the only protection.

- **Razorpay:** use the documented refund idempotency contract for the same refund request; order creation recovery uses the persisted receipt/order reference and authoritative lookup. Do not assume a universal idempotency header for every Razorpay endpoint.
- **Cashfree:** reuse the same persisted order/refund idempotency identity and identical request body on retry.
- **PayU:** retain the same transaction ID and refund token; because the classic command API does not provide the same generic idempotency contract as Cashfree, reconcile status before retrying an uncertain refund request.
- **PhonePe:** retain the merchant order/refund IDs; reconcile by those IDs before retrying an ambiguous create/refund request.
- **Paytm:** retain order ID and refund `refId`; a pending refund must be checked, not blindly resubmitted.
- **JioPay:** retain merchant transaction/refund numbers; use signed STATUS recovery before repeating a mutating operation.
- **All providers:** `outcomeUnknown` means do not create a new order/refund identity. Reconcile the original operation first.

### JioPay published status-response compatibility correction (8 November 2026)

The published JioPay hosted-checkout and status examples identify the merchant transaction with `merchantTxnNo` and the provider transaction with `txnID`; the status response uses `txnStatus: "SUC"` and does not include `currencyCode`. The earlier adapter only read `pgTransactionId` and required an explicit currency field. That meant a valid documented status response could not be bound to its payment ID or recognized as INR. The adapter and webhook ingress now prefer `txnID`, retain legacy identifier fallbacks, enforce an optional requested payment-ID match, and normalize an omitted currency to INR only within this INR-only adapter. Explicit non-INR responses remain non-capturable. Regression tests use the documented response shape. This is a contract-compatibility correction, not merchant UAT evidence.

## 3. Shared payment lifecycle controls

The required lifecycle is provider-independent:

1. Resolve the authenticated tenant and booking/folio on the server.
2. Derive amount and currency from the persisted folio balance; reject client-authoritative amounts.
3. Persist a payment intent and stable idempotency identity before calling a provider.
4. Create the provider order using the exact amount/currency and retain the provider-order binding.
5. Return only the provider-specific checkout handoff needed by the client. Never return merchant secrets.
6. Treat SDK callbacks, redirects and screenshots as untrusted hints.
7. Verify payment status server-to-server and bind provider, environment, tenant, order, payment ID, amount and currency.
8. Verify webhook authenticity against raw request bytes before trusting the event.
9. Persist webhook event identity and payload fingerprint in the durable inbox; handle redelivery and event conflicts transactionally.
10. Keep capture, accounting posting and provider settlement as distinct states.
11. Create refunds as separate financial operations; verify refund status before proposing a reversal.
12. Reconcile provider transaction records, Aurelia payment records and provider settlement statements.

The current webhook handler in `payment-backend/src/server.mjs` already performs the critical server-side verification and inbox transaction. It also keeps webhook evidence separate from accounting authorization. This is an important control to preserve.

## 4. Accounting and settlement boundary

A provider capture is not bank settlement. A provider refund request is not a completed refund. A valid webhook is not an accounting authorization.

Aurelia must keep these states separate:

- `PAYMENT_PENDING`: provider outcome not yet established.
- `AUTHORIZED`: provider authorization only; not a capture.
- `CAPTURED_VERIFIED`: provider status is authoritative and bound to the persisted intent.
- `ACCOUNTING_PENDING`: capture evidence exists but no canonical folio/journal posting is accepted.
- `POSTED_TO_FOLIO`: canonical PMS accounting transaction has committed and read-back has been verified.
- `SETTLED_BY_PROVIDER`: provider settlement statement/bank credit has been reconciled.
- `REFUND_PENDING`, `REFUNDED_VERIFIED`, and `REFUND_POSTED`: separate refund states.

Three-way reconciliation must compare:
1. provider transaction/payment/refund records;
2. Aurelia payment intent, inbox and journal evidence;
3. provider settlement statement and actual net settlement.

The current worker's Firestore collection mapping has not been proven to be the canonical deployed PMS ledger. Finance must approve the chart-of-accounts interpretation (including Account 2020) before any writer or scheduler is enabled. No provider-specific shortcut should bypass that gate.

## 5. Cross-provider acceptance matrix

Each of the six providers must pass the same acceptance scenarios independently, using its own merchant test account and the exact Android checkout path intended for release.

| Test | Expected result |
|---|---|
| Correct amount and currency | Provider order matches persisted folio amount and INR exactly. |
| Client amount tampering | Backend ignores/rejects altered client amount. |
| Duplicate initiate request | Same payment intent does not create a second charge/order. |
| Timeout after provider accepted request | Intent remains outcome-unknown; reconcile original provider reference before retry. |
| User cancels checkout | No capture or folio posting is recorded. |
| Android process death / app restart | App recovers by querying backend intent status; it does not infer failure or success locally. |
| Callback claims success but provider says pending/failed | No capture evidence or folio mutation. |
| Wrong order/payment/tenant/environment | Reject or quarantine; never attach evidence to another booking. |
| Amount/currency mismatch | Reject capture evidence and alert for investigation. |
| Invalid signature | Reject webhook without parsing it as trusted evidence. |
| Duplicate webhook | Same event is idempotent; no duplicate command or journal entry. |
| Distinct later status event | Do not misclassify it as a byte-identical replay; state transition rules decide whether it advances the payment. |
| Out-of-order webhook | Do not downgrade verified capture or terminal state. |
| Webhook unavailable | Provider status recovery can converge on the same idempotent workflow. |
| Partial and full refund | Amount, parent payment and refund identity are verified; cumulative refunds cannot exceed captured amount. |
| Refund timeout / pending state | Query refund status before retry; no premature refund-to-folio posting. |
| Provider settlement mismatch | Record an exception; do not silently alter folio or journal. |
| Key rotation | Current and permitted prior webhook secrets are handled according to provider retry semantics; no secrets enter logs. |

## 6. Production qualification evidence required per provider

The existing qualification gate requires all of the following evidence, independently reviewed and approved:

- Merchant UAT.
- Signed webhook verification.
- Provider status reconciliation.
- Refund lifecycle UAT.
- Android physical-device acceptance.
- Canonical PMS ledger parity.
- Incident response and alerting.
- Production readiness review.

Each evidence record must be current, attributable, linked to durable evidence and verified by someone other than the owner approving production qualification. A mocked test, adapter implementation, successful credential probe or documentation review cannot substitute for merchant UAT.

## 7. Current release decision

| Capability | Current decision |
|---|---|
| Six provider adapters and backend routes | Implemented foundation; test/UAT only |
| Six Android checkout handoffs | Implemented foundation; device qualification outstanding |
| Server-side provider status verification | Implemented; merchant UAT outstanding |
| Provider-specific webhook authentication | Implemented in adapters; merchant delivery/UAT outstanding |
| Durable webhook inbox and identity binding | Implemented in backend; production load/recovery acceptance outstanding |
| Provider refund create/status | Implemented in adapters; merchant refund UAT and folio posting outstanding |
| Canonical PMS accounting writer | Not authorized |
| Automated settlement/reconciliation scheduler | Not authorized |
| Live gateway collection | **OFF** |
| Automatic settlement | **OFF** |
| Automatic refund-to-folio posting | **OFF** |
| CCAvenue adapter registration | **DISABLED** |
| Production release | **NOT AUTHORIZED** |

## 8. Official provider references

The following are provider documentation entry points and relevant contracts to use during implementation/UAT. Merchant-specific product versions and account entitlements must still be confirmed with each provider.

- [Razorpay webhook verification and event handling](https://razorpay.com/docs/webhooks/validate-test/)
- [Cashfree webhook verification](https://www.cashfree.com/devstudio/preview/pg/tools/webhookVerification)
- [PayU webhook events and sample payloads](https://docs.payu.in/docs/webhook-events-and-sample-payloads)
- [PhonePe developer documentation](https://developer.phonepe.com/)
- [Paytm payment flow and server-side transaction status verification](https://business.paytm.com/docs/miniapps/payment-flow)
- [Jio Payment Solutions developer documentation](https://docs.jiopay.in/)

---

**Conclusion:** Apply one common payment trust and accounting model to all six registered providers, while keeping each provider's cryptography, endpoint contract, event identity and retry semantics specific to that provider. Do not register CCAvenue by analogy. The codebase already contains much of this architecture; the remaining work is primarily provider-specific merchant acceptance, Android/device proof, canonical ledger integration and settlement operations—not adding six parallel implementations of the same payment core.
