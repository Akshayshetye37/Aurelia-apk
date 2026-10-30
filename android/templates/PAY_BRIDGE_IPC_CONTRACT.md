# Aurelia Pay Bridge IPC contract

Status: PMS-side Messenger client implements connection discovery and protocol v1 handshake only. The separate Pay Bridge application has not been created and must implement this contract before the apps can connect.

## Android identity and access
- Pay Bridge package: `com.aurelia.paybridge`
- Explicit service class: `com.aurelia.paybridge.ipc.PayBridgeService`
- Service must be exported and protected by `com.aurelia.paybridge.permission.BIND_PAY_BRIDGE`.
- Pay Bridge must declare that permission with `android:protectionLevel="signature"`.
- PMS declares the matching `uses-permission` and narrow Android package-visibility query.
- Both APKs must be signed with the same trusted signing identity. PMS checks Android package signature equality before binding.
- PMS fails closed on missing package, signer mismatch, missing permission, invalid service identity, invalid handshake, or malformed response.
- Unexpected service-process disconnection, binding death, or bind/handshake timeout clears authenticated state immediately, unbinds the stale connection, and starts a controlled reconnect sequence. Each retry rechecks package signing identity and performs a fresh protocol handshake.
- Automatic reconnection uses at most five retries with delays of 1, 2, 4, 8, and 16 seconds. The retry loop stops after the limit; the PMS explicit Connect action starts a new attempt and resets the retry budget. Lifecycle resume calls do not reset or bypass the retry policy. A manual disconnect cancels pending retries and prevents reconnection until the user explicitly connects again.

## Messenger protocol v1
- Transport: Android `Messenger` over an explicit bound-service Intent.
- PMS sends `what=100` with a `Bundle` containing:
  - `protocolMin` (int, 1)
  - `protocolMax` (int, 1)
  - `packageName` (string, `com.aurelia.pms`)
  - `nonce` (string, unique per connection)
  - `replyTo` (Messenger)
- Pay Bridge replies to `replyTo` with `what=101` and a Bundle containing:
  - `protocolVersion` (int, must be 1)
  - `packageName` (string, must be `com.aurelia.paybridge`)
  - `nonce` (string, exact echo of PMS nonce)
  - `capabilitiesJson` (JSON array string containing unique, non-empty strings; `handshake` is mandatory)
- PMS accepts the connection only after the response passes all checks within **10 seconds**, measured from the start of binding. The timeout callback is explicitly removed after handshake success, terminal failure, or user disconnect. A bind/handshake timeout clears the current attempt and enters the bounded reconnect sequence.
- PMS validates the callback ComponentName package and service class, binder liveness, protocol version, package identity, nonce, and capability-array structure.
- capabilitiesJson must be a complete JSON array of unique, non-empty strings and must include the mandatory handshake capability. A response that omits it is rejected.
- PMS reports the SHA-256 fingerprint of the installed APK signer only after successful handshake.
- A green indicator means bound service plus successful protocol handshake and signer equality. Package installation alone is not connected. The indicator is cleared immediately on unexpected disconnection and restored only after a new handshake succeeds.

## Scope and payment safety
- This PMS client currently implements connection and protocol negotiation only.
- Payment initiation, transaction events, refunds, and evidence transfer remain disabled until their versioned messages are specified and implemented on both apps.
- Provider secrets and webhook secrets remain on the owner's trusted HTTPS backend, never in either APK.
- A payment response must never settle a folio automatically. Staff confirmation remains mandatory.
- Existing manual PMS payment methods remain available when Pay Bridge is absent.

## Future extension rules
- New protocol versions must negotiate explicitly; never silently reinterpret v1 messages.
- Payment messages must include unique request IDs, booking/folio IDs, integer amount in paise, currency, provider and merchant reference.
- Responses must echo request IDs and carry provider transaction identity and evidence metadata.
- PMS must validate request matching, amount, currency, duplicate events and evidence before presenting a result to staff.


## Reserved future message identifiers

The PMS build also includes `PayBridgeProtocol.java` as a constants-only contract dependency. The current connection client continues to send and accept only handshake messages 100 and 101.

Reserved operation identifiers (not implemented or advertised yet):
- 200/201: create payment / result
- 202/203: retrieve payment status / result
- 300/301: request refund / result
- 302/303: retrieve refund status / result
- 400/401: reconciliation request / result
- 500/501: payment event / acknowledgement

The future Bridge service manifest declaration is provided in `PAY_BRIDGE_MANIFEST_TEMPLATE.xml`. It is a template only and must be added to the separate Pay Bridge app, never to the PMS manifest. The service must also check caller permission and signer identity in its implementation; manifest protection alone does not replace per-request validation.

Every payment operation must carry a unique request ID, transaction ID where applicable, booking and folio references, integer amount in paise, ISO currency, provider ID and merchant reference. Refunds must reference the original provider transaction. Capabilities may be advertised only after the corresponding operation is fully implemented and tested on both apps.
