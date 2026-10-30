# Aurelia India payment-provider catalogue and integration policy

Research snapshot: 30 October 2026. Provider availability, product names and API versions can change. Always follow the merchant's current dashboard-issued integration kit and the provider's current official documentation.

## Product decision: one provider per merchant

Aurelia PMS supports a broad catalogue, but a merchant selects and configures **one** payment provider account at a time. A hotel does not need accounts with every provider. The selected provider is stored as the only configured entry in `S.set.paymentProviders`; selecting another provider replaces the previous selection. This avoids pretending that unrelated merchant accounts or credentials can be combined into one gateway.

The catalogue includes payment aggregators/platforms and direct bank gateways. They are different product categories and do not share a universal API. The provider adapter must be selected and implemented against that provider's specific contract.

## Provider catalogue researched from official sources

| Provider | Category | Official documentation |
|---|---|---|
| Razorpay | Payment aggregator | [Docs](https://razorpay.com/docs/) · [Checkout](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/) · [Webhooks](https://razorpay.com/docs/webhooks/) |
| Cashfree Payments | Payment aggregator | [Docs](https://www.cashfree.com/docs/) · [Gateway overview](https://www.cashfree.com/docs/payments/overview) · [Webhook verification](https://www.cashfree.com/devstudio/preview/pg/tools/webhookVerification) |
| PayU | Payment aggregator | [Docs](https://docs.payu.in/) · [Hosted checkout](https://docs.payu.in/docs/prebuilt-checkout-page-integration) · [Verify payment](https://docs.payu.in/docs/v2/docs/v2-non-seamless-api-integration-steps) |
| PhonePe PG | Payment aggregator | [Developer portal](https://developer.phonepe.com/) · [Standard Checkout V2](https://developer.phonepe.com/phonepe-payment-gateway/pg-v2-standard-checkout-integration) |
| Paytm PG | Payment aggregator | [Merchant docs](https://business.paytm.com/docs/) · [Initiate transaction](https://business.paytm.com/docs/api/initiate-transaction-api/) · [Callbacks/webhooks](https://business.paytm.com/docs/callback-and-webhook/) |
| CCAvenue | Payment aggregator | [FAQ/integration](https://www.ccavenue.com/faq) · [In-app payments](https://www.ccavenue.com/inapp-payments) |
| BillDesk | Payment aggregator | [Developer docs](https://docs.billdesk.io/) · [Integration FAQs](https://docs.billdesk.io/docs/integration-faqs) |
| Easebuzz | Payment aggregator | [Developer docs](https://docs.easebuzz.in/) · [Official site](https://easebuzz.in/) |
| NTT DATA Payment Services (Atom) | Payment aggregator | [Developer docs](https://atomtech.in/docs) |
| Zaakpay | Payment gateway | [Developer integration guide](https://developer.zaakpay.com/docs/integrating-zaakpay-payment-gateway) |
| Instamojo | Payment platform | [Payments API](https://docs.instamojo.com/v1.1/reference/payments-api) · [Webhook guidance](https://support.instamojo.com/hc/en-us/articles/208485755-Webhook-URL) |
| HDFC Bank SmartGateway | Direct bank gateway | [Developer docs](https://smartgateway.hdfc.bank.in/docs/) |
| SBIePay | Direct bank gateway | [Official portal](https://www.sbiepay.sbi/) |
| Axis Bank Payment Gateway | Direct bank gateway | [Merchant services](https://www.axisbank.com/business-banking/cash-management-services/payment-gateway) |
| ICICI Bank Eazypay / PG | Direct bank product | [Eazypay](https://eazypay.icicibank.com/) |
| Pine Labs | Payment platform/acquiring | [Official site](https://www.pinelabs.com/) · [Developer portal](https://developer.pinelabs.com/) |

The list is a practical India-focused catalogue, not a legal or exhaustive list of every RBI-authorised payment aggregator, bank acquirer, UPI app, POS provider or payment facilitator. Some brands above offer multiple products; merchant eligibility and enabled payment modes vary by agreement, KYC and underwriting. Google Pay, BHIM and other consumer UPI apps are payment apps/PSPs, not interchangeable merchant payment-gateway integrations, so they are not presented as merchant gateway accounts here.

Razorpay's own Optimizer documentation distinguishes bank gateways from aggregators and lists a wider ecosystem including BillDesk, Cashfree, CCAvenue, Easebuzz, Paytm, PayU, Pine Labs, Atom/Ingenico and others. See [provider categories](https://tfs.np.razorpay.in/docs/payments/optimizer/add-payment-providers) and [supported providers](https://tfs.np.razorpay.in/docs/payments/optimizer/supported-gateways-aggregators).

## Provider-neutral architecture

1. Merchant selects one provider and completes that provider's merchant onboarding/KYC.
2. PMS sends a folio payment intent (immutable booking reference, amount in INR paise, currency and idempotency key) to the trusted Aurelia backend.
3. Backend creates the provider-specific order/transaction and stores all credentials. It returns only a short-lived checkout token/redirect/session data to PMS or Pay Bridge.
4. Customer completes payment in the provider's hosted checkout or supported SDK.
5. Backend authenticates provider callbacks/webhooks using the exact current signature/hash/checksum contract. It also queries provider status to recover delayed or missing webhooks.
6. Backend validates merchant account, order reference, amount, currency and final captured/paid state. Events are idempotently stored and duplicates/out-of-order notifications are safe.
7. Only a backend-authorized, verified event may be considered for a folio settlement decision. Pending, failed, cancelled, refunded, disputed, mismatched, duplicate or ambiguous events never auto-settle.

## Important provider-specific differences

- Razorpay: create server-side Orders; verify Checkout signature against the stored order; verify webhook HMAC over the raw body; distinguish authorized from captured.
- Cashfree: create an order server-side; use payment-session checkout; verify webhook signature; query payments for the order because client callback/redirect alone is not final proof.
- PayU: validate response hashes and S2S webhooks; use Verify Payment API for reconciliation. PayU's current v3 API and legacy hosted flows have different contracts; do not mix examples.
- PhonePe: use current Standard Checkout V2 contracts, not legacy V1 snippets; authenticate webhook/callback and independently query order status.
- Paytm: initiate transaction server-side, validate checksum, and use Transaction Status API because callback status may be intermediate.
- Instamojo: webhook is form-encoded and includes MAC; validate MAC and query payment details by payment/payment-request IDs.
- BillDesk, CCAvenue, Easebuzz, Atom, Zaakpay and bank gateways: follow the specific merchant-enabled product's signing, response and status-query documentation. Do not assume they share Razorpay/PayU payload formats.

## Security and implementation boundaries

- No secret, salt, private key, webhook secret, API access token or merchant password may be stored in APK, browser storage, app backup, logs or Git.
- The PMS settings screen stores only a public merchant identifier and an HTTPS backend URL. It is not a provider connection.
- Pay Bridge remains a separate future APK and is not a substitute for the trusted backend.
- A browser redirect, Android intent result, screenshot, UPI notification or unsigned callback is not proof of payment.
- Keep automatic folio settlement disabled until provider-specific sandbox and live end-to-end tests pass.

## Current implementation status

- Provider catalogue and official documentation references: added to the PMS payment workspace.
- Single-provider-per-merchant selection: implemented in the PMS settings UI; selecting a new provider replaces the previous selected provider.
- Provider-specific setup/verification guidance: included for every catalogue entry.
- Actual provider API adapters, backend endpoints, webhook receivers and provider status polling: not implemented by this catalogue change.
- Separate Aurelia Pay Bridge APK: not yet built.
- Live merchant credentials and provider accounts: not connected.
- Automatic folio settlement: disabled.
