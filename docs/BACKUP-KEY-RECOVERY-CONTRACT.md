# Aurelia PMS encrypted backup and key-recovery service contract

Status: client-side cryptographic envelope implemented; trusted server service and cloud resources are NOT deployed.

## Client archive format

The app writes only AURELIA_PMS_BACKUP v1 envelopes. It no longer serializes the PMS snapshot directly into a backup file.

- Each backup gets a fresh random 256-bit DEK.
- The PMS snapshot (including the photo archive) is encrypted in 1 MiB AES-256-GCM chunks.
- Each chunk has a fresh 96-bit IV and authenticated data binding the property ID, backup ID, algorithm, chunk index and chunk count.
- The DEK is sent only to the key-recovery service over HTTPS for wrapping by a server-managed Cloud KMS key. The archive contains the KMS-wrapped DEK, key ID/version, authenticated chunk metadata and ciphertext; it never contains the raw DEK or plaintext snapshot.
- Restore requires the same property identity, a fresh Firebase ID token, an authorized owner membership and successful KMS unwrap. Every chunk is authenticated and the plaintext SHA-256 is checked before JSON parsing.
- The client does not persist Firebase ID tokens or fall back to plaintext backup/restore. If the owner session or key service is unavailable, backup and restore fail closed.

The current client calls:
- POST /v1/backup-keys/wrap
- POST /v1/backup-keys/unwrap

Request fields include propertyId, backupId, DEK/wrapped DEK, and base authenticated-data context. The service must return wrappedDek/keyId/keyVersion for wrap, and dek for unwrap.

## Required server implementation

The service is a release blocker until all of the following are implemented and deployed:

1. Verify Firebase ID tokens with Firebase Admin SDK, including revocation checking.
2. Resolve the authenticated Firebase UID and require an active owner/property membership for the exact propertyId on every wrap and unwrap request. Google authentication alone is not authorization.
3. Use a dedicated Cloud KMS symmetric AES-256-GCM key ring/key. Encrypt/decrypt the 32-byte DEK with the supplied authenticated data; never persist or log the raw DEK, ID token, or request body.
4. Bind KMS additional authenticated data to a canonical, versioned tuple of tenant/property ID, backup ID, archive format and algorithm. Reject mismatched IDs and malformed base64.
5. Return only the wrapped DEK and key resource version. On unwrap, return the raw DEK only to the already authenticated and authorized client over TLS; never store it in Firestore or application logs.
6. Enforce per-UID/property rate limits, request-size limits, replay-safe backup IDs, audit metadata without secrets, key-version rotation, tenant isolation, and least-privilege service-account IAM.
7. Keep Firestore membership writes server-only. Owners may read only their own active membership; clients may not create or change membership or KMS metadata.
8. Add emulator tests for missing/expired/revoked token, inactive membership, cross-property attempts, KMS AAD mismatch, key rotation, tampered archive, replay and rate limits.

## Infrastructure and configuration still required

- Firebase project with Google provider enabled and an Android OAuth Web client ID.
- Firebase Authentication and Firestore configuration for the Android app.
- Firestore owner-membership schema and server-only provisioning flow.
- Cloud KMS key ring/key and a Cloud Run service account with encrypt/decrypt permission only on that key.
- Deployed HTTPS service URL configured as AURELIA_BACKUP_KEY_SERVICE_URL.
- Android Google owner session provider exposed as window.AureliaOwnerSession with propertyId and getIdToken().

Until those resources and server checks exist, encrypted backups intentionally remain unavailable rather than producing plaintext files or using a user-managed PIN/recovery phrase.
