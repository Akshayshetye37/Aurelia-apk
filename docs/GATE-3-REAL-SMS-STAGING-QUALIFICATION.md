# Gate 3 — Real SMS staging qualification

**Status: NOT EXECUTED.** This gate requires a dedicated Firebase staging project, a real test SIM/handset and the staging APK artifact. Emulator OTP codes do not qualify as real SMS evidence.

## Staging-only configuration

Create the GitHub Environment `recovery-staging` and configure:

- GitHub Environment `recovery-staging` variables consumed by `.github/workflows/recovery-staging-deploy.yml`: `GCP_PROJECT_ID`, `PRODUCTION_GCP_PROJECT_ID`, `GCP_REGION`, `STAGING_FUNCTIONS_BASE_URL` (required HTTPS origin for the exact `${GCP_REGION}-${GCP_PROJECT_ID}.cloudfunctions.net` host), `RECOVERY_FUNCTIONS_SERVICE_ACCOUNT`, `RECOVERY_ATTESTATION_VERIFIER_URL`, `RECOVERY_SIGNING_KEY_ID`, `RECOVERY_GRANT_PUBLIC_KEYS_JSON`, `FIREBASE_WEB_API_KEY`, `APP_CHECK_PLAY_INTEGRITY_REGISTERED=true`, `APP_CHECK_SIGNER_SHA256`, and `ATTESTATION_APP_SIGNER_SHA256` (the two signer fingerprints must match). `RECOVERY_CALLABLES` is optional and defaults to the 12 recovery callables listed in the workflow.
- GitHub Environment `recovery-staging` configuration: `GCP_WORKLOAD_IDENTITY_PROVIDER` and `STAGING_DEPLOY_SERVICE_ACCOUNT` are non-secret identifiers and should be configured as environment **variables** (the workflow supports a secret fallback for both). The WIF provider must be the full `projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>` resource name; the deploy identity must be a service-account email. The workflow now validates these before calling Google authentication. Required environment secrets: `GOOGLE_SERVICES_JSON_BASE64`, `STAGING_KEYSTORE_BASE64`, `STAGING_KEYSTORE_PASSWORD`, `STAGING_KEY_ALIAS`, and `STAGING_KEY_PASSWORD`.
- The separate attestation-verifier deployment may additionally require `RECOVERY_ATTESTATION_SERVICE_ACCOUNT`, `ATTESTATION_APP_PACKAGE`, and `ATTESTATION_APP_MIN_VERSION`; those are not consumed by this staging deploy workflow itself. Do not substitute the older `GCP_DEPLOY_SERVICE_ACCOUNT` or `AURELIA_RELEASE_*` names for the exact Gate 3 names above.
- Secret Manager versions in the staging project: `PHONE_PEPPER`, `RECOVERY_SIGNING_KEY_PKCS8`.
- The signing public key ring must contain the active `RECOVERY_SIGNING_KEY_ID`. The private key is never stored in GitHub variables or this repository.

Run `Recovery staging deployment and APK` only after the private attestation verifier is deployed. The workflow sets `RECOVERY_ENABLED=true` only in this staging project, deploys Functions, probes missing/invalid App Check tokens on every recovery callable, then builds a release-signed app APK and matching release-signed androidTest APK with the staging Firebase configuration. It verifies that both APKs use the configured app signer and uploads both artifacts plus their SHA-256/certificate fingerprints (7-day retention). Production remains disabled.

## Gate 3 hardening contract

- The authoritative callable inventory is `scripts/gates/callables.json`; both staging deploy probes and evidence probes consume it. After deployment, the gate reconciles it with the real Gen2 Functions list and fails on missing or extra callables.
- The production project ID must be pinned in `scripts/gates/production-project.json`. The current value is intentionally `UNCONFIGURED` because the authoritative ID was not present in this repository; staging qualification fails closed until a reviewer replaces it with the actual production ID. The GitHub Environment production ID must match and staging must differ.
- Evidence is validated by `scripts/gates/validate-gate3-evidence.mjs` before the evidence writer. Zero probes, missing callable cases, invalid HTTP results, mismatched candidate SHA, missing APK/signer hashes, missing callable inventory and unexplained exclusions are rejected.
- Evidence reports separate statuses for staging deployment, App Check negative probes, APK build/signing, physical SMS recovery and overall Gate 3. Successful staging evidence is not overall qualification.
- Physical SMS recovery requires a committed matrix tied to the exact candidate SHA with reviewer, signed timestamp and matrix commit reference. See `docs/GATE-3-PHYSICAL-DEVICE-MATRIX-TEMPLATE.md`.
- Emulator concurrency tests exercise 20 parallel rate-limit requests and 20 parallel grant-consumption attempts using emulator Firestore transactions. These are test additions; they are not considered passing until executed.
- WIF trust restrictions and staging-vs-production IAM isolation remain live Google Cloud qualification blockers. Repository checks alone cannot prove those policies.

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
