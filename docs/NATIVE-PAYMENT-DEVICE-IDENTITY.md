# Native payment-device identity and attestation

Status: challenge-bound Android Key Attestation is implemented as a native source primitive. Owner-authorized enrollment, appliance-side certificate verification and physical-device acceptance remain release blockers.

## Challenge-bound identity creation

`android/templates/security/PaymentDeviceKeyStore.kt` exposes `createAttestedIdentity(serverChallenge: ByteArray)`. The caller must obtain a fresh, random 16–128 byte challenge from the appliance through an authenticated owner-enrollment session. The method creates a separate staged P-256 signing key with Android Key Attestation, requests StrongBox first, retries in the TEE only when Android reports StrongBox unavailable, and rejects a key that Android does not classify as hardware-backed.

The returned structure contains the staged key alias, public key PEM, the complete X.509 certificate chain encoded as Base64, and the locally observed security level. The method checks that the leaf certificate public key matches the generated public key. The attested key is staged separately from the legacy identity so a failed enrollment attempt does not destroy the currently active identity. Signing uses the attested key when present.

On Android 12/API 31 and later, the local security level must be StrongBox or Trusted Environment. On Android 9–11, Android exposes only the older hardware-backed indicator; the client reports `HARDWARE_BACKED_UNCLASSIFIED`, which the appliance must evaluate under its own policy. Devices below Android 9 are rejected.

## Appliance is the verifier

The PMS/Bridge must not trust the client-reported security level or certificate chain. The appliance must independently validate the chain to an explicitly maintained Android Key Attestation trust-root set and apply certificate revocation policy; verify the challenge byte-for-byte against the outstanding, single-use, short-lived owner-issued challenge; verify leaf/public-key equality; verify package name and approved signing-certificate digest; enforce hardware level, verified boot, device lock, OS and patch policy; and bind the verified key to owner, property and intended device as `PENDING_ACTIVATION`. Explicit owner activation, immediate revocation and safe key rotation are mandatory.

A certificate chain is evidence for the appliance to validate, not proof that validation has occurred. A client signature proves possession of the corresponding private key; it does not prove provider capture, webhook validity, folio identity or accounting approval.

## Existing protocol transcripts

The existing domain-separated `AURELIA_DEVICE_ACTIVATE_V1` and `AURELIA_DEVICE_REQUEST_V1` transcripts remain unchanged. No JavaScript interface or network transport is exposed by this class.

## Remaining acceptance gates

- Owner-session challenge issuance, single-use storage, enrollment and activation endpoints.
- Appliance-side certificate-chain, challenge, package/signing digest and device-state verification.
- Native client lifecycle integration, safe rotation, revocation enforcement and recovery.
- Instrumentation tests on at least one StrongBox device and one TEE-only device, including software-key rejection.
- Physical-device crash/restart and signed-release acceptance.

Attestation alone does not authorize a payment or folio credit. Payment IPC remains handshake-only, live collection remains disabled, and automatic folio settlement remains disabled.
