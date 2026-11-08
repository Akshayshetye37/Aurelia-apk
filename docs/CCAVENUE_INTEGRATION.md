# CCAvenue integration decision and implementation boundary

**Status: NOT IMPLEMENTED / NOT ENABLED.** CCAvenue remains catalogue-only. Do not advertise it as an implemented adapter, do not expose checkout routes, and do not enable live collection, settlement or refund posting.

## Correct integration model

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
verification, refund creation and refund status. The current CCAvenue material
in this repository does not establish a complete, merchant-approved contract
for all seven operations. In particular, the previously reviewed API v1.3
material describes split-refund in a split-payout context; that is not evidence
of a general refund lifecycle suitable for this adapter contract.

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
- Current API specification for order status, transaction lookup, webhook or
  redirect authentication, and general full/partial refund creation/status.
- Merchant-specific environment names, endpoint base URLs, `regId`,
  merchant ID, access-code configuration and approved callback/redirect URLs.
- CCAvenue sandbox account and test cases for success, decline, pending,
  timeout, duplicate order, callback replay, full refund and partial refund.

Do not put access codes, working keys, encryption keys, passwords or GitHub
package tokens in source control, issue comments or chat. Configure them in
Google Secret Manager after the integration contract is reviewed.

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
