# PMS-side Pay Bridge integration boundary

Status: PMS-side integration foundation only. This document describes what the PMS project owns; it does not claim that the separate Pay Bridge APK or payment backend exists.

## What is implemented in the PMS project

- A native Android Messenger client template at `android/templates/PayBridgeClient.java`.
- Explicit binding to `com.aurelia.paybridge/.ipc.PayBridgeService`.
- Narrow package visibility for the companion package.
- Signature-level service permission declaration on the PMS side.
- Package signing-identity equality check before binding.
- Protocol-v1 nonce handshake, service identity checks, bounded reconnect and fail-closed status.
- A constants-only shared message contract in `PayBridgeProtocol.java`.
- A JavaScript bridge in the generated PMS `MainActivity` exposing connection status and explicit connect/disconnect actions.
- A provider catalogue and onboarding documentation; no merchant secrets are collected by the PMS.
- A strict JavaScript capability gate: an authenticated connection must have the expected package, protocol v1, a SHA-256 signing fingerprint and the mandatory `handshake` capability. Provider management requires the separately negotiated `provider.management` capability.

## What the PMS deliberately does not implement yet

The PMS client currently supports connection and handshake only. It does not send payment creation, refund, reconciliation or provider configuration IPC messages. Reserved message identifiers are not executable features.

Do not add gateway SDK dependencies to the PMS APK. Native provider SDKs belong in the separate Pay Bridge Android application. Merchant API secrets, webhook secrets, signing salts and private keys belong only in the trusted payment backend.

## Runtime rules

1. Manual PMS payment recording remains usable when Pay Bridge is missing, disconnected or incompatible.
2. A successful package handshake authenticates the companion application; it does not authenticate a hotel merchant account.
3. Provider configuration must remain unavailable until the bridge explicitly advertises and implements `provider.management`.
4. Payment execution must remain unavailable until both applications negotiate the relevant payment capability and the backend has implemented the provider workflow.
5. The PMS must never treat an IPC callback, browser redirect, screenshot or client-side SDK result as authoritative payment proof.
6. Only backend-verified transaction events may be presented as verified for folio posting. Folio posting remains idempotent and separate from folio closure.
7. New payment IPC operations require a versioned contract, request correlation IDs, amount/currency/folio binding, strict validation and tests on both APKs.

## Build/deployment boundary

The PMS CI generates the Capacitor Android project and copies the native templates into it. The PMS build does not build or publish Pay Bridge. The companion application must be created, signed with the controlled Aurelia signing identity, released and installed separately.

A PMS APK build passing proves only the PMS build and its tests. It does not prove that Pay Bridge is installed, that provider SDKs work, or that live payments are enabled.
