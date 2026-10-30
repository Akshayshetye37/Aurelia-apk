# Aurelia Pay Bridge IPC contract

Status: PMS-side Messenger client is implemented. The separate Pay Bridge application must implement this exact contract before the apps can connect.

## Android identity and access
- Pay Bridge package: `com.aurelia.paybridge`
- Explicit service class: `com.aurelia.paybridge.ipc.PayBridgeService`
- Service must be exported and protected by `com.aurelia.paybridge.permission.BIND_PAY_BRIDGE`.
- Pay Bridge must declare that permission with `android:protectionLevel="signature"`.
- PMS declares the matching `uses-permission` and narrow Android package-visibility query.
- Both APKs must be signed with the same trusted signing identity. PMS checks Android package signature equality before binding.
- PMS fails closed on missing package, signer mismatch, missing permission, missing service, invalid handshake, timeout, or disconnect.

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
  - `capabilitiesJson` (JSON array string)
- PMS accepts the connection only after the response passes all checks within 8 seconds.
- PMS reports the SHA-256 fingerprint of the installed APK signer only after successful handshake.
- A green indicator means bound service plus successful protocol handshake and signer equality. Package installation alone is not connected.

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
