# Aurelia Identity and Credential Boundaries

Status: security architecture invariant; qualification requirements.

## Identity domains

Aurelia must keep these identity domains distinct. Credentials, tokens, secrets, and authorization decisions must not be reused across domains.

| Domain | Identity / credential | Authority | Must not grant |
|---|---|---|---|
| PMS application user | Individual PMS account/session and permissions | Day-to-day application access to explicitly authorized tenant data | Vault recovery, deployment, cloud IAM |
| Vault owner | Owner UID + tenant binding + local vault enrollment | Recovery authorization for that owner's vault | Access to another user's vault or tenant |
| Recovery phone | Firebase phone-auth proof for the enrolled recovery destination | Proof of possession in the recovery protocol | DEK derivation, staff login, cloud IAM |
| Recovery grant | Short-lived signed, one-use, tenant/owner/device/nonce-bound grant | Continue the owner recovery flow after server checks | Direct database decryption or cross-tenant access |
| Staging deployment | GitHub OIDC/WIF and staging service account | Deploy and qualify staging only | PMS user authentication, owner recovery, production recovery |
| Repository operator | Individual GitHub identity and protected environment approval | CI/CD governance | PMS data or vault access |
| Cloud administrator | Individual GCP IAM identity | Infrastructure administration and break-glass | Routine PMS user login |

## Local-first and vault ownership

- Encrypted local PMS storage remains primary.
- Each vault must have an explicit owner and tenant context.
- User authentication and application authorization are separate checks.
- Recovery credentials are owner-specific. A phone OTP is not a shared staff password and does not derive, regenerate, or replace the DEK.
- PIN, biometric, and recovery-key wrappers must remain independent wrappers around the same existing DEK; recovery must not create a replacement DEK as a shortcut.
- Local and external backups must be associated with the originating vault owner. Export and restore operations must verify the caller's authorization for that owner/vault before reading, writing, replacing, or merging data.
- No implicit cross-user restore, vault merge, owner transfer, or export is permitted.
- Cloud/SAF backup export remains optional and user-consented. Opaque transport may carry ciphertext only; it must not receive plaintext credentials, recovery keys, or DEKs.

## Backend tenant/owner enforcement

For every recovery callable that reads or mutates tenant state:

1. Derive or validate tenant from a trusted server-issued identity claim or an already-established owner record; never trust a client-supplied tenant ID by itself.
2. Bind owner UID and tenant together and reject mismatches.
3. Bind device identity to the enrolled owner and verified attestation.
4. Bind grants to tenant, owner UID, device hash, nonce, scope, expiry and one-use JTI.
5. Perform authorization before mutating state; use atomic transactions for one-use state.
6. Apply abuse controls within the correct scope. Tenant-specific device buckets must include tenant ID; global IP controls may remain global.
7. Reject cross-tenant passkey actions, alert acknowledgements, grants, enrollment and cancellation.
8. Client Firestore rules must deny direct access to recovery secrets and server-authoritative state.

## Staging identity rules

- WIF, deploy service accounts, and verifier caller identities are environment identities.
- Staging identities may deploy/probe staging only and must not be PMS user or recovery-owner credentials.
- Use synthetic tenants, synthetic owners, and test phone numbers for qualification.
- Each qualification result is tied to the exact candidate SHA, APK hashes, signing certificate, environment, test identity and device. One owner's pass is not evidence for all owners.
- Production `RECOVERY_ENABLED` remains false until the required gates and evidence are approved.

## Required negative tests

- Tenant A grant consumed with Tenant B owner session: reject, no state mutation.
- Tenant A alert acknowledged by Tenant B owner/device/token: reject, Tenant A alert remains pending.
- Same device hash across synthetic tenants: device rate limits remain tenant-isolated.
- Owner UID mismatch within a tenant: reject.
- Unattested or wrong-owner device: reject.
- Cross-tenant passkey enrollment/action: reject.
- Backup export by non-owner: reject.
- Restore into another owner's vault without explicit authorized transfer: reject.
- Logs/evidence contain no raw OTP, phone, token, PIN, recovery key, DEK or owner identifier.

Source-contract and emulator tests are development evidence only. G3-11 through G3-14 require live staging evidence; physical-device evidence is separately required by Gate 4.

## Backup authorization model and migration boundary

The current PMS local-first installation identity is `LOCAL_ONLY`; the application does not yet provide a multi-user authenticated vault-owner session for ordinary PMS data. Therefore backup authorization is possession-based, not account-based: creating encrypted backups requires the local backup key to be unlocked, portable encrypted restore requires the recovery password, and server backup access requires the owner-configured bearer token. These mechanisms must not be represented as proof of a PMS staff/user identity or as cross-tenant authorization.

Legacy v4 plaintext backup import is retained for migration compatibility but now requires a separate explicit warning confirmation before parsing/staging records. It is not encrypted or owner-authenticated. Never import such files from an untrusted source. The normal restore/import confirmation remains a separate step before records are applied.

The multi-user PMS authorization model must be designed before shared-device staff vaults, cross-user export, restore, merge, or owner transfer are introduced. Do not retrofit an assumed owner UID into portable backups until the account/tenant lifecycle and replacement-device recovery semantics are defined.
