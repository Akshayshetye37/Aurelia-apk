# Public GitHub provider reference audit

Research date: 8 November 2026. Scope: targeted search of public GitHub repositories relevant to Aurelia's Indian payment-provider adapters, Android checkout handoff, webhook reconciliation and refunds. This is not an exhaustive enumeration of every public GitHub repository: GitHub search/indexing cannot establish that every repository was found. Vendor repositories are treated as compatibility evidence, not as a substitute for the merchant's current product contract or UAT.

## Repositories reviewed

| Repository | Maintainer / nature | Useful material | Aurelia decision |
|---|---|---|---|
| [razorpay/razorpay-node](https://github.com/razorpay/razorpay-node) | Razorpay-maintained official Node SDK | Checkout signature verification, exact-body webhook HMAC, payment/refund resources and webhook event management. Payment signature uses `order_id|payment_id`. | Aurelia retains its native adapter and timing-safe signature comparison. Use the SDK for field/endpoint cross-checks, not as a replacement for amount/order/status binding. |
| [cashfree/pg-samples](https://github.com/cashfree/pg-samples) | Cashfree-maintained sample suite | Node Express/Hono/Koa/Nest, Java/Spring, Android native, Flutter, React Native and web examples. | Useful for checking Android SDK handoff and frontend integration patterns. Do not import whole sample applications or dependencies. |
| [cashfree/cashfree-pg-webhook](https://github.com/cashfree/cashfree-pg-webhook) | Cashfree-maintained webhook sample | Captures raw JSON bytes; HMAC-SHA256 over timestamp + exact raw body, Base64 encoded. | Confirms Aurelia's raw-body signature construction. Sample's timestamp check is one-sided and its secret is a placeholder; Aurelia keeps bounded timestamp freshness and constant-time comparison. |
| [PhonePe/phonepe-pg-sdk-java](https://github.com/PhonePe/phonepe-pg-sdk-java) | PhonePe-maintained Java SDK, Apache-2.0 | Standard Checkout v2, integer paise, merchantOrderId, status lookup, callback Basic Authentication, callback event/payload models, paymentDetails/transactionId and refund status. | Keep Aurelia's Node adapter. Distinguish PhonePe provider orderId from merchantOrderId. Authenticate callback and independently query status. Test documented event names. |
| [paytm/paytm-pg-node-sdk](https://github.com/paytm/paytm-pg-node-sdk) | Paytm-maintained Node SDK | Native status/refund request and response models; txnId, bankTxnId, orderId, MID, refundId and refId. | Use as a schema cross-check. Keep transaction ID, bank reference and refund ID distinct; retain signed status lookup and MID/order binding. |
| [payu-india/payu-sdk-node](https://github.com/payu-india/payu-sdk-node) | PayU India-maintained Node SDK | Server-side key/salt handling, payment hash generation and reverse response hash validation. | Confirms hosted-checkout hash direction and backend-only salt. Do not reuse hosted checkout reverse hash for command API authentication. |
| [PHPCoreLab/payment-gateways](https://github.com/PHPCoreLab/payment-gateways) | Third-party PHP multi-gateway library | Unified provider interface, DTO separation and routing concepts. | Architecture inspiration only. Not vendor-authoritative and not used as protocol evidence. No code copied. |
| [senthilinfo62/ccavenue-payment-gateway-integration-in-android-sdk-master](https://github.com/senthilinfo62/ccavenue-payment-gateway-integration-in-android-sdk-master) | Third-party legacy Android sample | Historical RSA/GetRSA hosted WebView flow and obsolete Android build stack. | Already reviewed. No RSA/WebView scraping or old dependencies imported. |

## Findings by provider

### Razorpay
The official SDK's documented checkout signature is HMAC-SHA256 over `order_id|payment_id`; webhook verification HMACs the exact request body. Its helper uses ordinary string comparison, while Aurelia uses a fixed-length digest check and `timingSafeEqual`. Keep API key secret and webhook secret separate. No additional code change was justified.

### Cashfree
The official webhook sample confirms raw-body preservation and timestamp + body HMAC-SHA256/Base64. Its timestamp freshness example is not a complete two-sided freshness policy. Cashfree's sample suite is the strongest public source reviewed for Android native/Flutter/React Native checkout integration patterns. No adapter code change was justified.

### PhonePe
The official SDK validates callbacks using the configured Basic Authentication username/password. Callback envelope is `event` + `payload`; payload model includes both provider `orderId` and merchant `merchantOrderId`, while paymentDetails contains `transactionId`, state and amount. Documented events include `checkout.order.completed`, `checkout.order.failed` and `checkout.transaction.attempt.failed`. Aurelia uses the merchant order reference for status lookup and independently verifies provider status before capture qualification. Callback event names alone are never proof of payment.

### Paytm
The official Node SDK models payment and refund status with separate transaction, bank transaction, order, merchant and refund references. Aurelia's signed status/refund requests and MID/order binding remain the trust anchor. Merchant UAT must confirm the precise Paytm product/API version and its response variants.

### PayU
The PayU India Node SDK keeps key/salt server-side and validates hosted checkout's reverse hash. Hosted checkout response hash and command API request hash are separate operations. Aurelia preserves this separation and requires the verify-payment result to indicate captured status. Merchant-specific credentials and sandbox evidence remain necessary.

### CCAvenue
The public GitHub results reviewed were third-party legacy samples, not a verifiable current official merchant SDK release. Do not adopt their cryptography by analogy. Require the current merchant kit, official AES vectors, Tracking ID API contract, notification authentication and refund/status UAT.

### JioPay
No vendor-maintained JioPay GitHub SDK suitable as a protocol authority was identified in this targeted search. Use [JioPay's official developer documentation](https://docs.jiopay.in/). Aurelia's recent `txnID` / `txnStatus` correction follows the published JioPay contract, not an unrelated third-party code sample.

## Cross-provider rules retained

1. Preserve exact raw webhook bytes before JSON/form parsing.
2. Authenticate provider-specific callbacks, then query authoritative provider status.
3. Bind tenant, environment, merchant order, provider payment ID, amount and currency before capture verification.
4. Keep payment ID, bank reference, refund ID and provider refund ID distinct.
5. A refund accepted response is not proof of completed refund settlement.
6. Treat redirect URLs, SDK callbacks, browser returns and client-side status as hints only.
7. Keep API secrets, webhook secrets, salts and encryption keys server-side and purpose-separated.
8. Keep each provider's signature, status, event identity and refund semantics isolated behind the adapter contract.
9. Pin SDK versions and record the merchant's actual product/API version before production changes.
10. Never infer production support from public samples, star counts or mock tests.

## Implementation impact

No provider code was copied or rewritten solely because a public repository showed a different demo implementation. The existing Aurelia adapters already implement the key trust boundaries identified in the vendor-maintained references. This audit records reusable evidence and unsafe sample patterns so future work can be reviewed consistently.

The JioPay status-response correction immediately preceding this audit remains the code correction from this research cycle. Backend CI, settlement foundation CI, infrastructure validation and PMS source/web packaging passed on commit `10e6ca9b07b2e29be36f50f2f6561c15b1fc564d`. Merchant UAT and Android device acceptance remain outstanding.
