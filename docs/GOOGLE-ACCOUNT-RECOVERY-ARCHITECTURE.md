# Aurelia PMS — Google-account-authorized encrypted recovery

Status: approved product requirement; cryptographic protocol and operational implementation remain a release gate.

## Product requirement

An owner must be able to restore an encrypted Aurelia PMS backup on a replacement Android device after signing in with the same Google account, without creating or entering an Aurelia PIN, OTP, password, passphrase, or manually stored recovery code.

Google Sign-In is the account authentication and authorization factor. It is not itself an encryption key, and a Google ID token, OAuth access token, email address, or Android device credential must never be used directly as a database key or backup key.

Aurelia must not operate a hosted backup repository or central backup-key service. Backup bytes remain in a folder selected by the owner through Android Storage Access Framework (SAF), using the owner's installed cloud/document provider if desired.

## Required key separation

- SQLCipher uses a random 256-bit database data-encryption key (DEK).
- On each device, Android Keystore protects the local DEK wrapping key and Android's native device-authentication prompt gates use of that local key.
- Backup encryption uses a fresh random 256-bit backup DEK per archive and AES-256-GCM authenticated encryption with unique nonces and property/backup/version-bound AAD.
- The backup DEK is not the SQLCipher DEK. It is never stored in plaintext in the archive, app preferences, browser storage, logs, or a sibling file.
- Account identity, property authorization, device identity, local Keystore keys, database DEK and backup DEK remain distinct.

## Cross-device recovery constraint

A Google ID token is a signed, short-lived bearer assertion. It does not contain a stable secret from which an application can safely derive a decryption key. Google Sign-In does not give Aurelia a generic Google-held encryption key or a general-purpose API to unwrap arbitrary application ciphertext. A replacement device's Android Keystore and screen lock cannot unwrap keys protected only by the old device.

Therefore the following are prohibited:
- Deriving encryption keys from email, Google UID, ID tokens, OAuth access/refresh tokens, or other public/stable identity values.
- Treating successful Google authentication alone as recovery of the original device-bound SQLCipher key.
- Uploading plaintext DEKs, unencrypted databases, or plaintext backup archives to Drive or any other provider.
- Placing a wrapped key next to ciphertext and claiming it is recoverable without specifying and verifying who holds the corresponding private key.
- Silently generating a new DEK when an existing database or backup key is unavailable.
- Claiming cross-device recovery before negative cryptographic and physical-device tests pass.

## Recovery architecture decision to implement

Use an owner-controlled, end-to-end encrypted account recovery envelope with no Aurelia-operated storage or key service. The implementation must select and document a standard, reviewed protocol before code is written. The recovery envelope may be stored inside the encrypted backup archive or in the same owner-selected SAF folder, but it must be cryptographically bound to the owner subject, immutable property ID, backup ID, format version and algorithm suite.

The protocol must establish a high-entropy recovery capability that is independent of Google tokens and inaccessible to the storage provider. It must define how a replacement device obtains that capability after Google account authentication without requiring the user to remember or manually enter a new secret. If that cannot be achieved using supported Google/Android platform guarantees, do not claim the requirement is met: require an explicit trusted-device transfer or another user-approved recovery factor and clearly disclose the limitation.

The architecture review must compare at minimum:
1. Google/Android-supported end-to-end encrypted credential/key backup facilities, where app-specific export/import and account recovery semantics are documented and available.
2. Authenticated device-to-device key transfer initiated by the already-unlocked original device, with explicit owner approval, ephemeral key agreement, transcript binding and replay protection.
3. A user-controlled recovery secret as a fallback only if the owner explicitly changes the product requirement. It is not the default and must not be silently introduced.

Do not invent a Google account encryption API. Confirm exact platform availability, backup behavior, account recovery behavior, device migration semantics, Android version constraints, and developer terms from authoritative documentation before implementation.

## Authorization model

- Google account authentication establishes a Firebase/Google subject only in Google Mode; Local Mode continues to operate without internet.
- The authenticated subject must be authorized for the exact property before any restore operation.
- Owner/property membership must be verified from a trusted source. A client-provided property ID or email match is not sufficient authorization.
- Without a central Aurelia service, establish how membership authorization is provisioned and cryptographically verified. A backup's self-asserted owner/property metadata is not proof of ownership.
- Do not make Firebase or Cloud KMS mandatory solely to browse or read a user-selected SAF folder. Any optional online identity integration must not become a dependency for Local Mode.

## Restore protocol and safeguards

1. Owner chooses Google Mode and signs in, or enters Local Mode where supported.
2. App verifies owner authorization for the backup's immutable property identity.
3. Owner explicitly selects a candidate archive from the SAF folder; never restore automatically.
4. Validate archive magic, schema version, size limits, metadata, owner/property binding and cryptographic envelope structure before processing.
5. Recover the archive DEK using the approved recovery protocol; do not use the replacement phone's Keystore key as if it were the old device's key.
6. Authenticate and decrypt every AEAD chunk; verify the complete manifest and plaintext digest.
7. Stage into a separate SQLCipher database, run SQLCipher/SQLite integrity checks and domain invariants, and verify property identity.
8. Show a restore summary and require explicit final confirmation.
9. Atomically switch canonical database authority only after every validation passes; preserve the previous database and a rollback point.
10. Record a redacted local audit event. Never log keys, tokens, guest data, payment data, raw provider responses or plaintext snapshots.

Any failed authentication, ownership check, key recovery, chunk authentication, digest, schema, SQL integrity or domain invariant must leave the live database untouched.

## Backup provider behavior

- Local PMS and local encrypted backup must work offline.
- Cloud backup is optional and uses an owner-selected SAF document tree and persistable URI permission where supported.
- Aurelia does not collect cloud passwords and does not implement Drive REST upload for this design.
- A selected provider may be unavailable, offline, revoked, or may not support background scheduling. Surface this as a backup status; never report a backup as complete before write, read-back and integrity verification.
- SAF permissions do not automatically transfer to a new device; owner selects the folder again.
- Keep backup discovery scoped to the selected tree. Never silently scan all cloud accounts or folders.

## Acceptance criteria

- No mandatory Aurelia-operated server, Cloud KMS, or hosted backup storage.
- No Aurelia PIN, OTP, password, passphrase or manually entered recovery code in the default Google recovery flow.
- Google tokens are used only for authentication/authorization and never as encryption keys or key-derivation inputs.
- Same-device unlock remains protected by Android Keystore and native device authentication.
- Replacement-device recovery works only through a fully specified, standards-based, security-reviewed key-transfer/recovery protocol.
- Unauthorized Google account, wrong property, changed owner subject, altered archive metadata, corrupted ciphertext, duplicate/replayed chunks, rollback, missing key material and revoked provider access all fail closed.
- No plaintext DEK, database or backup is written to SAF, browser storage, logs or diagnostics.
- Restore is staged, verified, user-confirmed and atomic; the existing live database remains recoverable on failure.
- Unit/contract tests, Android instrumentation tests and physical-device tests cover successful and negative paths, including lost original device and Google account recovery.
- Documentation and UI state clearly distinguish local backup, owner-cloud backup, same-device restore and cross-device restore.

## Current PR #98 correction required

The current `docs/BACKUP-KEY-RECOVERY-CONTRACT.md` specifies a Firebase-authenticated Cloud Run + Cloud KMS wrap/unwrap service. That is incompatible with the no-Aurelia-server/no-central-KMS product constraint and must not be described as the final architecture.

The PR's existing server-wrapped envelope implementation must remain disabled for release until replaced or explicitly re-scoped. Do not simply remove the server dependency and write plaintext keys or derive a key from Google identity. The current PR must remain draft until this design gate is resolved and verified.
