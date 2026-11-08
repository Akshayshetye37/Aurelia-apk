# CCAvenue integration decision and implementation boundary

**Status: NOT IMPLEMENTED / NOT ENABLED.** CCAvenue remains catalogue-only. Do not advertise it as an implemented adapter, do not expose checkout routes, and do not enable live collection, settlement or refund posting.

## Correct integration model

## Important distinction: Web Integration v3.1 is not the Mobile SDK flow

The supplied Integration Document v3.1 describes the classic hosted billing-page
flow. It posts `encRequest` and `access_code` to
`/transaction/transaction.do?command=initiateTransaction`; the request is
encrypted using the merchant integration kit's `AesCryptUtil` and the
merchant's encryption key. The guide's sample calls that value `enc_key`.
It does not specify the MD5(working_key) key-and-IV construction in the
submitted Node.js snippet. That construction is therefore not adopted.

The v3.1 guide also describes a different merchant parameter contract:
`merchant_id`, `order_id`, `currency`, `amount`, `redirect_url`,
`cancel_url`, and `language`. The user's proposed `generateSecurePayload`
is only a partial classic web-checkout parameter builder; it is not the
Mobile SDK Tracking ID API.

The Mobile SDK v1.7 flow is distinct:

- Backend creates a CCAvenue Tracking ID by posting `access_code` and
  AES-128-encrypted merchant parameters including `regId`, currency, amount
  and order ID to the Tracking ID Generation API.
- Backend decrypts the returned `encResp` using the merchant-kit-compatible
  AES implementation and validates its status and tracking ID.
- Backend computes the Mobile SDK request hash using the documented SHA-512
  concatenation. This hash primitive is implemented and covered by the
  published test vector.
- Android receives the SDK's documented request dictionary, including
  `trackingId` and `requestHash`, and launches the official merchant SDK.
  It does not receive a classic `encRequest` token and does not launch an
  invented Activity class.

The public v3.1 PDF is not a substitute for the current merchant-specific
Mobile SDK kit. Neither guide provides enough evidence to safely implement
the precise AES key derivation/padding/encoding in this project without the
official server sample or known-answer test vectors. Do not infer an IV from
the working key, and do not assume the access code, working key and encryption
key are interchangeable.


The previously proposed RSA public-key flow and Android class
`com.ccavenue.android.automated.CCAvenueActivity` are not supported by the
CCAvenue Mobile SDK Integration Guide v1.7 (28 March 2024).

The v1.7 mobile integration describes this sequence:

1. The Aurelia backend creates the order from a persisted payment intent.
2. The backend calls the CCAvenue Tracking ID Generation API. Its request
   contains an AES-128-encrypted merchant parameter string and the merchant
   access code. The backend decrypts `encResp` and validates the returned
   tracking ID and response status.
3. The backend creates the SDK request hash as
   `SHA512(tracking_id + currency + amount + working_key)`.
4. The app receives only the non-secret SDK parameters, tracking ID and
   request hash from the backend. The working key and any encryption material
   never enter the APK or client response.
5. The official merchant-issued Android SDK is launched using the exact
   classes, dependency coordinates and callback contract in that merchant's
   current Integration Kit.
6. The app callback is only a reconciliation hint. Aurelia independently
   verifies transaction status with CCAvenue before recording provider
   evidence. A client callback is never capture proof.

The pure request-hash primitive is implemented in
`src/providers/ccavenue-mobile-crypto.mjs` and has a regression test against
the SHA-512 example published in v1.7. It is intentionally not wired into a
checkout route or adapter until tracking-ID creation, response decryption and
provider status/refund semantics are implemented and verified.

## Why the adapter is still not registered

Aurelia's shared adapter contract requires credential validation, order
creation, lookup by reference, authoritative payment status, webhook
verification, refund creation and refund status. CCAvenue Merchant API v1.3
(29 April 2020) documents `orderStatusTracker` for authoritative order status,
but its refund operation is `splitRefund` for funds split to sub-account IDs;
that is not a general merchant refund operation. A separate older API v1.1
document (28 November 2016) documents `getRefundDetails` for querying refunds
by CCAvenue reference number, not creating them. These sources establish
status lookup and refund-detail lookup, but do not establish a complete
ordinary refund lifecycle or a webhook-signature contract. Therefore the
seven-operation adapter contract is still not met.

The mobile guide also points to a merchant-specific Android SDK package and
private package access. The exact SDK binary, current package coordinates,
dependency credentials, Android initialization API, callback API, encryption
utility/key derivation and merchant endpoint configuration must come from the
merchant's current official kit. No guessed class name, dependency, AES mode,
IV, key derivation or endpoint is accepted.

## Required merchant integration material

Supply the current CCAvenue-issued kit through the project's secure artifact
channel, with all credentials and tokens removed:

- Server-side integration kit/source for Tracking ID Generation, AES
  encryption/decryption and response parsing.
- Current Android Mobile SDK AAR or official package instructions, sample app,
  exact dependency coordinates and supported Android/Gradle versions.
- Current merchant-confirmed API specification and access for order status,
  callback authentication, and general full/partial refund creation/status.
  Public Merchant API v1.3 does document `orderStatusTracker`; use the
  merchant-confirmed current version and registered server IP.
- Merchant-specific environment names, endpoint base URLs, `regId`,
  merchant ID, access-code configuration and approved callback/redirect URLs.
- CCAvenue sandbox account and test cases for success, decline, pending,
  timeout, duplicate order, callback replay, full refund and partial refund.

Do not put access codes, working keys, encryption keys, passwords or GitHub
package tokens in source control, issue comments or chat. Configure them in
Google Secret Manager after the integration contract is reviewed.

## Review of the supplied operational snippets

The snippets are treated as proposals, not as a verified merchant kit. The
following corrections apply before any implementation is connected:

### Server handler

- Do not use `qs` unless it is explicitly added and locked as a dependency.
  For the Mobile SDK flow, construct the documented merchant parameter string
  with a fixed allowlist and a deterministic encoder; never accept arbitrary
  client-provided parameter names.
- Do not use `Number(amountPaise) / 100` to create payment amounts. Amounts
  must come from the persisted Aurelia payment intent, be represented in
  integer paise internally, and be formatted once as a two-decimal string.
- The proposed MD5-derived key/IV is not accepted. Merchant API v1.3 describes
  an Encryption Key mapped to the Access Code, while Mobile SDK v1.7 separately
  uses the Working Key for requestHash. The AES mode, key encoding, IV,
  padding and transport encoding must match the merchant-issued kit and its
  test vectors; these values must not be conflated.
- Tracking ID creation is not the classic `initiateTransaction` URL. It is a
  separate server-to-server API call with `access_code` and `encRequest`;
  the response `encResp` must be decrypted and checked for `status === 0`
  and a non-empty tracking ID before requestHash generation.
- Bind the returned tracking ID to the original tenant, payment intent,
  order ID, amount and currency in persistent server state. Duplicate and
  timeout recovery must not silently create a second payable order.

### Android SDK

- Do not use `CCAvenueWebPaymentActivity`, `setClassName`, hand-built
  `encRequest` intent extras or the classic hosted-checkout URL in the
  Mobile SDK integration.
- The v1.7 guide identifies the Android SDK artifact as
  `com.ccavenue.android:indiasdk:2.0.2@aar`, uses an `AvenueOrder` request
  object and the `AvenuesTransactionCallBack` callback interface. These
  declarations are a guide reference, not proof that the merchant's current
  private package is accessible or that this exact binary remains supported.
- The guide's package access uses private GitHub Packages credentials. Those
  credentials must be supplied through CI secrets/Gradle properties and must
  never be committed in a Gradle file, workflow log or APK.
- Only pass the SDK fields required by the official `AvenueOrder` contract.
  Never pass the working key, encryption key or server signing material to
  Android. The request hash is generated by the backend.
- Treat SDK callback results as hints for polling. Only a backend status
  query with amount/order/currency/provider-reference binding can establish
  provider-verified payment evidence.

### Test and qualification workflow

The repository has no checked-in root `gradlew` or static
`app/proguard-rules.pro`. Android is generated from Capacitor and the
`android/templates` tree by the existing PMS build workflow. Therefore the
submitted standalone workflow's Gradle commands and file paths are invalid
for this project.

The existing `.github/workflows/payment-backend-ci.yml` is the backend CI
entry point: it uses Node 22, runs the complete backend test suite, syntax
checks, builds the Cloud Run image and validates Terraform. It now also runs
the CCAvenue known-answer test explicitly and includes a Gitleaks scan. Android
SDK compilation/R8 checks must be added only after the merchant-issued AAR
and its real package API have been integrated into the generated Gradle
project; do not add a ProGuard keep rule for an unverified namespace.

## Release acceptance gates

CCAvenue may only be registered after all of the following are complete:

- [ ] Tracking ID API implementation with strict order/amount/currency binding,
      timeout handling and idempotent recovery.
- [ ] AES request/response compatibility tests using merchant-approved test
      vectors; no locally invented cryptographic parameters.
- [ ] SHA-512 request hash tests, including the published v1.7 vector.
- [ ] Official Android SDK dependency integrated in generated Gradle project;
      Kotlin/Java compilation and R8/minification verified.
- [ ] SDK callback treated as untrusted; server-side status lookup determines
      final provider state.
- [ ] Webhook/redirect verification and replay protection, where supported by
      the merchant's actual API contract.
- [ ] General refund and refund-status semantics proven, including partial
      refunds, idempotency and cumulative refund caps. Split-refund alone does
      not satisfy this gate.
- [ ] All seven adapter operations pass contract tests and merchant sandbox
      UAT; failure, pending and ambiguous outcomes are covered.
- [ ] Physical-device checkout and lifecycle recovery accepted.
- [ ] Independent production qualification and explicit release authorization.

Until those gates are evidenced, `ccavenue` must remain absent from the
adapter factory. Live collection, automatic settlement and automatic refund
posting remain OFF.

## Public CCAvenue documentation review (8 November 2026)

The following public CCAvenue pages were reviewed:

- In-App Payments: https://www.ccavenue.com/inapp-payments
  CCAvenue publicly confirms mobile SDK support for Android, iOS and Windows.
  The public product page does not publish the full SDK API contract or the
  merchant-specific SDK download.
- Merchant Registration & On-boarding: https://www.ccavenue.com/compliance
  CCAvenue describes its underwriting, operations, legal and risk review and
  states that the Payment Gateway Integration Kit is sent in the activation
  email after merchant approval/activation.
- Technical FAQ: https://www.ccavenue.com/faq
  CCAvenue describes website payment interfaces and merchant onboarding
  requirements. It is not a replacement for the merchant's integration kit.
- MARS API key navigation is referenced by CCAvenue's public Zoho integration
  instructions: https://www.ccavenue.com/zoho (Settings > API Keys).

### Credential configuration — deliberately deferred until merchant setup

The provider catalogue defines the merchant-entered fields below; no real
values are required in source control now. The Encryption Key is distinct from
the Mobile SDK Working Key and is required for the Merchant API AES request /
response envelope described in API v1.3:

| Field | Purpose | Storage |
|---|---|---|
| merchantId | Merchant identifier passed to the Mobile SDK | Non-secret configuration |
| regId | CCAvenue registration ID used in Tracking ID generation | Non-secret configuration |
| accessCode | CCAvenue API access code | Secret Manager |
| encryptionKey | API AES encryption/decryption key mapped to Access Code | Secret Manager; server only |
| workingKey | Mobile SDK SHA-512 requestHash key | Secret Manager; server only |

The current Mobile SDK v1.7 guide does not establish a separate generic
apiKey field. Do not add or request one unless the merchant's current
CCAvenue-issued kit explicitly requires it. Access code, encryption key and
working key must never be exposed to Android, browser responses, logs,
screenshots, or source control. Merchant API v1.3 also requires the merchant's
server public IP to be registered by CCAvenue before API calls will work. These are intended future configuration fields only: the current admin
credential-save/validation route deliberately rejects CCAvenue while no
complete adapter is registered. Do not present the fields as currently
configurable in the live admin UI. Enable that route only alongside the
verified adapter, secure secret handling and merchant-kit crypto implementation.

The public website confirms product availability and onboarding/kit delivery.
The published Merchant API v1.3 guide provides the orderStatusTracker API and
the API envelope contract; the older API v1.1 guide provides getRefundDetails.
However, the public material does not provide enough authoritative evidence
to safely implement the AES-128 Tracking ID request/response codec, prove a
general refund-creation operation, establish signed webhooks, or verify the
current private Android package coordinates. Those must be taken from the merchant activation kit. No values
from third-party document mirrors or leaked examples are used as credentials
or implementation authority.

### Additional published API contract evidence

- Merchant API v1.3, dated 29 April 2020, hosted on CCAvenue's
  `links.avenues.info` document domain:
  https://links.avenues.info/downloads/CCAvenues_API_Vers-1_3.pdf
  It documents `orderStatusTracker`, the `DoWebTrans` staging and production
  API hosts, JSON/XML/string request formats, AES-encrypted `enc_request`,
  encrypted `enc_response`, and status values `0` (API call succeeded) and
  `1` (API call failed). The order lookup can use the merchant `order_no`,
  CCAvenue `reference_no`, or both. Its returned order status vocabulary
  includes Successful, Shipped, Awaited, Initiated, Unsuccessful, Refunded,
  Auto-Reversed and other operational states. Do not equate a browser return
  or SDK callback with this server-side status result.
- The same v1.3 document's API inventory lists `splitRefund`, explicitly
  described as refunding amounts split to a sub-account through Split Payout.
  It does not document a generic standalone refund-create operation.
- A separate Merchant API v1.1 `getRefundDetails` guide, dated 28 November
  2016, is mirrored by the National Institute of Solar Energy:
  https://testing.nise.res.in/assets/upload/front/1560925577CCAvenues_API_Vers-1_1_getRefundDetails_Verified.pdf
  It documents lookup by CCAvenue `reference_no` and refund states
  `TS-REFC`, `TS-REFA`, `TS-REFF` and `TS-REFD`. This is an old document
  hosted by a third party; treat it as corroborating evidence only and
  confirm its availability/version with CCAvenue before production use.

These API documents materially improve the status-lookup specification, but
they still do not provide a verified AES implementation/test vector for the
merchant's account, a signed webhook contract, or an ordinary refund-create
operation. The API v1.3 guide also requires CCAvenue to register the server's
public IP before API calls are accepted. These account-side prerequisites
cannot be completed from source code or by inventing credentials.
## Additional official CCAvenue capabilities verified (8 November 2026)

A review of CCAvenue's current public product documentation found two capabilities that must be included in the implementation plan:

### Dynamic Event Notifications

CCAvenue's official Dynamic Event Notifications article confirms merchant-configured event destination URLs and notifications for order status, order risk status, disputes, reconciliation status and recurring-payment alerts. Its 2014 press announcement additionally identifies Order Refund Status notifications for full or partial refunds requested and processed by the bank.

Implementation rule: the notification endpoint must preserve the raw request, apply the exact authentication/integrity mechanism documented by the merchant's current integration kit, enforce replay/idempotency controls, and enqueue provider-status reconciliation. A notification is not payment or refund evidence by itself. The adapter must confirm the order/refund using CCAvenue's authoritative server API before returning verified state. The public article says the event is posted securely but does not specify a verifiable signature/header contract, so no HMAC or other signature scheme may be invented.

Official references:
- https://www.ccavenue.com/article/Receive-real-time-updates-of-key-events-in-your-Merchant-Account-through-CCAvenues-Dynamic-Event-Notifications
- https://www.ccavenue.com/pr/Get-real-time-status-updates-of-crucial-events-in-your-account-with-Dynamic-Event-Notifications

### Instant Refund API

CCAvenue's official Instant Refunds product article explicitly advertises APIs that trigger refunds. It also says the feature is available to live businesses on the platform and currently supports only specific BIN sets of leading card networks. This corrects the earlier broad inference that no programmatic ordinary-refund facility exists at all: an API product exists, but public documentation does not disclose its endpoint, request fields, authentication, idempotency, refund-reference semantics, eligibility checks or status lookup contract.

The adapter must implement this product when the merchant account is enabled for it. Do not substitute splitRefund (which is only for Split Payout sub-accounts), and do not emulate a refund by automating the M.A.R.S. browser interface. Until CCAvenue supplies the Instant Refund API specification and confirms merchant/BIN eligibility, refund initiation remains fail-closed. Refund status can be reconciled using the merchant-confirmed API and the Order Refund Status event; the older getRefundDetails guide is only corroborating lookup documentation and must be version-confirmed.

Official references:
- https://www.ccavenue.com/article/Enhance-Customer-Experience-and-Boost-Retention-Substantially-with-CCAvenue-Instant-Refunds
- https://www.ccavenue.com/ccavenue-mobile-app
- https://www.ccavenue.com/article/track-and-manage-your-orders-swiftly-and-efficiently-with-ccavenues-order-lookup-feature.jsp

### Updated end-to-end target

CCAvenue must be integrated as a peer adapter with these operations: credential validation; idempotent order/tracking-ID creation; order lookup by Aurelia reference; authoritative payment status; authenticated event ingestion followed by authoritative reconciliation; full/partial refund initiation when the merchant's Instant Refund entitlement/API is confirmed; and refund-status lookup. The Android handoff must use the merchant's current official SDK kit, with backend-generated requestHash and no merchant secrets in the APK.

The implementation must not advertise full lifecycle capability until the merchant-issued kit supplies and the sandbox proves: AES request/response compatibility, SDK package/API, event authentication, status API contract, Instant Refund API contract and merchant eligibility. The adapter remains unregistered and all live financial switches remain OFF until then.
## Official public integration document review (CCAvenue Integration v3.3, November 2021)

CCAvenue's public Integration Document v3.3 was retrieved from its Avenues document host: https://links.avenues.info/downloads/CCAvenue_Integration_Ver_3_3.pdf . It is materially more useful than the public marketing pages and defines a classic hosted checkout path that can be implemented independently of the Mobile SDK.

### Publicly documented hosted checkout contract

- M.A.R.S. Settings > API Keys provides Merchant ID, Access Code and Working Key for the test/production integration (document pp. 4, 7). The sample transaction code passes the merchant secret as `enc_key` to `AesCryptUtil`, encrypts the assembled request string and posts `encRequest` plus `access_code` to `https://test.ccavenue.com/transaction/transaction.do?command=initiateTransaction` (pp. 7-8).
- Production billing-page host in this document is `https://secure.ccavenue.com`; test host is `https://test.ccavenue.com` (p. 4). The Merchant API v1.3 status API uses its separate `api.ccavenue.com` / `apitest.ccavenue.com` hosts. These are different interfaces and must not be interchanged.
- Required request fields include `merchant_id`, unique merchant-generated `order_id`, three-letter `currency`, decimal `amount`, `redirect_url`, `cancel_url` and `language` (pp. 8-9). CCAvenue explicitly warns that it does not enforce uniqueness of merchant `order_id`; Aurelia must enforce uniqueness itself.
- The response contains `order_id`, CCAvenue `tracking_id` (numeric, up to 12 digits), `bank_ref_no`, `order_status`, `failure_message`, `payment_mode`, `status_code`, `status_message`, `currency` and `Amount` (pp. 51-52). Documented callback statuses are `Success`, `Failure`, `Aborted`, `Invalid` and `Timeout`.
- The Integration Document explicitly instructs merchants to validate the returned `order_id`, `currency` and `Amount` before providing services (pp. 51-52). Aurelia must additionally bind tenant, payment intent, original amount/currency and unique order ID, then independently query provider status before treating capture as verified.
- For iFrame checkout, the guide shows the encrypted request being posted through a server endpoint and the returned HTML/payment payload being loaded into an iframe (pp. 15-16, 39). This is an alternative web checkout integration, not the Android SDK.

### Important credential-name reconciliation

The 2021 v3.3 classic integration guide calls the M.A.R.S. credential `Working Key` in its API Keys list, while its sample code passes the same configured transaction secret into `AesCryptUtil` as `enc_key`. The later Mobile SDK guide uses a `working_key` in the SHA-512 requestHash formula. These labels are not sufficient to assume the two secrets are interchangeable across products. Keep the backend fields purpose-specific until the merchant's current M.A.R.S. account and activation kit confirm which credential belongs to each interface: classic hosted checkout encryption, Merchant API v1.3 encrypted API envelope, and Mobile SDK requestHash.

### What the official public sources do and do not establish

Confirmed by CCAvenue public material:
- Hosted billing page and iFrame checkout request/response fields and environment hosts: Integration v3.3.
- Server-side encrypted request construction using CCAvenue's `AesCryptUtil` class and merchant-specific secret: Integration v3.3.
- Mobile SDKs exist for Android, iOS and Windows, but the public product page does not publish SDK classes, package coordinates or a downloadable SDK: https://www.ccavenue.com/inapp-payments.
- Dynamic Event Notifications support order status, risk status, dispute status, reconciliation status and recurring-payment alerts; merchants configure event URLs in M.A.R.S. CCAvenue describes the event object as posted securely but does not publish a cryptographic signature/header contract in this article: https://www.ccavenue.com/article/Receive-real-time-updates-of-key-events-in-your-Merchant-Account-through-CCAvenues-Dynamic-Event-Notifications.
- Instant Refund API exists, but CCAvenue says it is currently limited to specific BIN sets of leading card networks and businesses live on its platform. The public product article does not publish the technical API contract or confirm that a particular merchant is enabled: https://www.ccavenue.com/article/Enhance-Customer-Experience-and-Boost-Retention-Substantially-with-CCAvenue-Instant-Refunds.
- CCAvenue says the merchant-specific Payment Gateway Integration Kit is sent in the auto-generated activation email after merchant account activation: https://www.ccavenue.com/compliance (Activation of the Merchant Account section).

### Implementation decision

Aurelia can now build a classic hosted checkout adapter path against the public v3.3 field contract, while keeping cryptographic compatibility dependent on the exact official `AesCryptUtil` implementation and test vectors. The request encryption primitive must not be reverse-engineered from sample ciphertext or guessed from unrelated GitHub libraries. The callback parser can be implemented against the published response fields, but a callback alone must not prove capture; use the documented Merchant API v1.3 `orderStatusTracker` for authoritative reconciliation and validate order ID, amount, currency and tracking/reference identity.

Dynamic Event Notifications should be wired as a provider event intake that stores the raw event safely, deduplicates it, and schedules authoritative status lookup. Until CCAvenue supplies the notification authentication contract, the endpoint must not treat an incoming event as trusted evidence. Instant Refund must be an optional capability gated by confirmed merchant entitlement and the merchant-specific API contract; the adapter must not silently fall back to manual M.A.R.S. refunds or splitRefund.

Official public document references:
- CCAvenue Integration v3.3 (November 2021): https://links.avenues.info/downloads/CCAvenue_Integration_Ver_3_3.pdf
- CCAvenue merchant activation and Integration Kit delivery: https://www.ccavenue.com/compliance
- CCAvenue in-app SDK product: https://www.ccavenue.com/inapp-payments
- CCAvenue Dynamic Event Notifications: https://www.ccavenue.com/article/Receive-real-time-updates-of-key-events-in-your-Merchant-Account-through-CCAvenues-Dynamic-Event-Notifications
- CCAvenue Instant Refunds: https://www.ccavenue.com/article/Enhance-Customer-Experience-and-Boost-Retention-Substantially-with-CCAvenue-Instant-Refunds
