# Aurelia Pay Bridge IPC contract (PMS side)

Status: contract groundwork only. This file does not claim that a live connection exists.

## Identity and Android access
- Pay Bridge package: `com.aurelia.paybridge`
- Explicit service component: `com.aurelia.paybridge/.ipc.PayBridgeService`
- Required service permission: `com.aurelia.paybridge.permission.BIND_PAY_BRIDGE`
- The permission must be declared by Pay Bridge with Android `protectionLevel="signature"`.
- PMS declares the matching `uses-permission` and a narrow Android package-visibility query.
- Both APKs must be signed by the same trusted signing identity for the signature permission to be granted.
- PMS must fail closed if the package, permission, service, signer, or handshake is unavailable.

## Protocol requirements
- Transport: Android bound service using Messenger (or a versioned AIDL contract).
- Protocol version: integer, negotiated on every connection.
- Handshake must return the service protocol version, package identity, and capabilities.
- Connection UI may show green only after successful service binding and authenticated handshake.
- Package installation alone, an Intent launch, or a JavaScript event is not authentication.
- No certificate fingerprint is pinned until the production signing identity is selected and verified.

## Payment boundary
- Payment requests carry unique request IDs, booking/folio IDs, amount in paise, currency, provider and merchant reference.
- Responses must echo the request ID and include provider transaction identity and evidence metadata.
- PMS validates response shape, request matching, amount and currency before exposing evidence to staff.
- A payment response never settles a folio automatically. Staff confirmation remains mandatory.
- Provider secrets and webhook secrets remain on the owner's trusted HTTPS backend, never in either APK.

## Failure behavior
Missing app, missing signature permission, wrong signer, service unavailable, protocol mismatch,
timeout, malformed message, or revoked authorization must leave gateway settings locked and
manual PMS payment methods operational.
