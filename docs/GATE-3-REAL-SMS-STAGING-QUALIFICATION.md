# Gate 3 — Real SMS staging qualification

**Status: NOT EXECUTED.** This gate requires a dedicated Firebase staging project, a real test SIM/handset and the staging APK artifact. Emulator OTP codes do not qualify as real SMS evidence.

## Staging-only configuration

Create the GitHub Environment `recovery-staging` and configure:

- GitHub Environment `recovery-staging` variables: `GCP_PROJECT_ID`, `PRODUCTION_GCP_PROJECT_ID` (the separate production project ID used by the staging deployment guard), `GCP_REGION`, `RECOVERY_FUNCTIONS_SERVICE_ACCOUNT`, `RECOVERY_ATTESTATION_SERVICE_ACCOUNT`, `RECOVERY_ATTESTATION_VERIFIER_URL` (private Cloud Run URL), `RECOVERY_SIGNING_KEY_ID`, `RECOVERY_GRANT_PUBLIC_KEYS_JSON`, `FIREBASE_WEB_API_KEY`, `ATTESTATION_APP_PACKAGE`, `ATTESTATION_APP_MIN_VERSION`, `ATTESTATION_APP_SIGNER_SHA256`, `APP_CHECK_PLAY_INTEGRITY_REGISTERED=true`, and `APP_CHECK_SIGNER_SHA256` (must match the APK signer and attestation verifier fingerprint).
- `recovery-attestation-deploy.yml` secrets: `GCP_WORKLOAD_IDENTITY_PROVIDER` and `GCP_DEPLOY_SERVICE_ACCOUNT`.
- `recovery-staging-deploy.yml` secrets: `GCP_WORKLOAD_IDENTITY_PROVIDER`, `STAGING_DEPLOY_SERVICE_ACCOUNT`, `GOOGLE_SERVICES_JSON_BASE64`, `STAGING_KEYSTORE_BASE64`, `STAGING_KEYSTORE_PASSWORD`, `STAGING_KEY_ALIAS`, and `STAGING_KEY_PASSWORD`.
- Secret Manager versions in the staging project: `PHONE_PEPPER`, `RECOVERY_SIGNING_KEY_PKCS8`.
- The signing public key ring must contain the active `RECOVERY_SIGNING_KEY_ID`. The private key is never stored in GitHub variables or this repository.

Run `.github/workflows/recovery-attestation-deploy.yml` from the trusted `integration/ledger-patch` branch with the frozen `candidate_sha` first. It verifies the candidate is still the exact `work/p0-storage-hardening` head, builds the verifier from that exact commit, deploys it privately, and probes unauthenticated/authenticated access plus malformed-attestation rejection. Copy the resulting Cloud Run URL into the `RECOVERY_ATTESTATION_VERIFIER_URL` variable in `recovery-staging`. Then run `.github/workflows/gate-3-real-sms-staging.yml` from `integration/ledger-patch` with the same candidate SHA. The staging workflow checks the frozen candidate and only then deploys the Firebase Functions and builds the APK. The workflow sets `RECOVERY_ENABLED=true` only in this staging project, deploys Functions, probes missing/invalid App Check tokens on every recovery callable, then builds a release-signed app APK and matching release-signed androidTest APK with the staging Firebase configuration. It verifies that both APKs use the configured app signer and uploads both artifacts plus their SHA-256/certificate fingerprints (7-day retention). Production remains disabled.

## Real-device test matrix

| ID | Test | Required result |
|---|---|---|
| G3-01 | Install the staging APK; register the owner recovery phone; verify the phone is stored encrypted locally. | Only the registered phone can be used by Forgot PIN; no phone input or cloud escrow of DEK. |
| G3-02 | Request OTP and submit an incorrect code. | Rejected; no grant, no local recovery gate, no DEK operation. |
| G3-03 | Allow an OTP to expire, then submit it. | Rejected; no grant and no gate arm. |
| G3-04 | Submit the same OTP proof twice. | Second use rejected; no second grant. |
| G3-05 | Verify the independent owner alert; open it and explicitly acknowledge from a fresh primary-auth owner session. | Merely receiving/displaying FCM never starts the hold; acknowledgement is single-use, expires after 15 minutes and is accepted only from an attested device with a fresh email-link/passkey owner session. No SMS/alert is sent to the recovery number. |
| G3-06 | Wait the full 24-hour hold; request a fresh OTP and grant. | Old OTP cannot be reused; new grant is UID/tenant/device/nonce-bound and expires within five minutes. |
| G3-07 | Submit wrong tenant, UID, device, nonce, signature, key ID, expired and replayed grants. | Every invalid grant rejected before the recovery gate arms. |
| G3-08 | Complete recovery using the offline recovery key. | SMS and grant authorize the workflow only; neither receives or derives the DEK. The offline key unwraps the original DEK and PIN B wraps that same DEK. |
| G3-09 | Inspect app files, shared preferences and logcat. | No plaintext PIN, OTP, recovery key, DEK, JWT or raw phone number. |
| G3-10 | Verify staging release APK and companion instrumentation APK. | Both artifacts originate from the same SHA, have matching approved signer SHA-256, and their separate APK SHA-256 values are recorded. |

## Evidence record

For each case record the candidate SHA, staging project ID, APK SHA-256, signing certificate SHA-1/SHA-256, redacted device label, Android API, test-run ID, result and reviewer. Never record OTP values, raw phone numbers, credentials or device serials in this repository.

**Exit condition:** all G3 cases pass on the same candidate SHA used by Gates 1 and 2. Gate 3 remains NOT QUALIFIED until real SMS is exercised on a physical staging device. Production recovery remains OFF.


**Android API floor:** The app retains its API 23 local-first support. Hardware-attested recovery enrollment requires API 24 or later because Android added `KeyGenParameterSpec.Builder.setAttestationChallenge` in API 24. On API 23, the app fails recovery enrollment closed before modifying any existing Keystore alias. Local PIN unlock remains available; biometric-vault enrollment and hardware-attested recovery require API 24 or later.


All recovery staging and verifier deployment workflows are restricted to `work/p0-storage-hardening`. The physical-device workflow also verifies that the successful staging artifact originated from that branch and the exact candidate SHA.


## Required real-SMS attestation metadata

The reviewer-approved `sms` attestation must include `smsDeliveredAt` (RFC 3339/ISO timestamp within 15 minutes before `testedAt`), `challengeId` (UUID v4 ID returned by `createRecoveryAttestationChallenge` for Android hardware-key attestation; it is not Firebase Phone Auth's opaque `verificationId`), `deviceLabel` (human-readable model/OS label with no serial or phone data), and `deviceIdentitySha256` (64-character lowercase SHA-256 of a redacted device identity). Record the delivery timestamp when the handset receives the SMS and correlate it to the challenge; do not record the OTP, phone number, SMS body, device serial, IMEI, or raw device identifier. The validator rejects missing, stale, future, malformed, or mismatched metadata. The Firebase SDK remains responsible for OTP verification.


The staging deploy identity must also have Cloud Run read access (`roles/run.viewer`) in the staging project so the preflight can read the deployed verifier's service URL and IAM policy. The attestation deployment identity is separate and needs the deploy permissions described by its protected environment; do not grant those deploy permissions to the read-only Gate 5 audit identity.
