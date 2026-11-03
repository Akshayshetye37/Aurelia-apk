# Native payment-device identity foundation

Status: source-level cryptographic primitive implemented; the Android device lifecycle and payment consumer are not yet wired or accepted on a physical device.

## PaymentDeviceKeyStore

android/templates/security/PaymentDeviceKeyStore.kt creates and retains a P-256 (secp256r1) signing key in Android Keystore. The private key is non-exportable. Android Keystore may use hardware-backed storage when the device supports it; this source does not claim StrongBox or hardware-backed attestation. It provides:

- Public-key export as PEM/SPKI for the owner-authenticated registration endpoint.
- The exact domain-separated AURELIA_DEVICE_ACTIVATE_V1 proof-of-possession transcript used by the LAN server.
- The exact domain-separated AURELIA_DEVICE_REQUEST_V1 transcript used by signed device requests.
- Explicit local key deletion for device retirement/re-enrollment.

The maintained Android generator copies this template into the generated app's native security package.

## Security boundary

This class is a native cryptographic primitive only. It intentionally has no JavaScript interface and performs no HTTP calls. It must be called only by a future native device client that validates the configured appliance origin, constructs canonical request bodies, manages owner-authorized enrollment, handles lease expiry and verifies response bindings.

A device signature proves possession of the registered device key. It does not prove provider capture, webhook validity, folio identity, or owner/staff accounting approval. A signed device lease is not an accounting authorization token. Do not use this primitive to authorize a folio credit by itself.

## Not yet implemented

- Owner-session-mediated native registration/challenge/activation flow.
- Native signed lease polling and response validation.
- Native command authorization / explicit accounting approval UI.
- Durable PMS folio projection, read-back verification, signed acknowledgement and cursor progression.
- Revocation handling in the on-device client, process-death recovery, sandbox acceptance and physical-device tests.

Live collection and automatic folio settlement remain disabled.