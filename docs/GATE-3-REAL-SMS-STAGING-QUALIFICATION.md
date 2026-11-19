# Gate 3 — Google Sign-In and Passwordless Email-Link staging qualification

**Scope: Google Sign-In + Firebase Passwordless Email-Link owner verification.** Gate 3 no longer qualifies real SMS delivery and does not require a physical SMS test device, real test SIM, Blaze SMS quota, or SMS receipt. Phone OTP remains in the application and Gate 2 OTP/recovery instrumentation; it is not removed or disabled by this migration.

## Authentication boundary

- **Google Sign-In:** primary account identity. It identifies the owner/account and is separate from local SQLite encryption.
- **Firebase Passwordless Email-Link:** sensitive owner verification. The owner requests a link, Firebase verifies it, and the backend validates immutable owner UID, tenant, verified email, and authentication freshness before issuing a trusted owner session.
- **Phone SMS OTP:** out of Gate 3 qualification scope. Gate 2 continues to cover OTP/recovery instrumentation.
- Neither Google Sign-In nor Email-Link session can unwrap, regenerate, or replace the local DEK. The offline Recovery Key remains the cryptographic recovery authority.

## Staging-only configuration

Create GitHub Environment `recovery-staging` and configure:

- Variables consumed by `.github/workflows/recovery-staging-deploy.yml`: `GCP_PROJECT_ID`, `PRODUCTION_GCP_PROJECT_ID`, `GCP_REGION`, `STAGING_FUNCTIONS_BASE_URL` (HTTPS origin must be exactly `${GCP_REGION}-${GCP_PROJECT_ID}.cloudfunctions.net`), `RECOVERY_FUNCTIONS_SERVICE_ACCOUNT`, `RECOVERY_ATTESTATION_VERIFIER_URL`, `RECOVERY_SIGNING_KEY_ID`, `RECOVERY_GRANT_PUBLIC_KEYS_JSON`, `FIREBASE_WEB_API_KEY`, `APP_CHECK_PLAY_INTEGRITY_REGISTERED=true`, `APP_CHECK_SIGNER_SHA256`, and `ATTESTATION_APP_SIGNER_SHA256` (fingerprints must match).
- `RECOVERY_CALLABLES` defaults to owner-verification callables: `exchangeOwnerEmailLink`, `confirmRecoveryOwnerBinding`, `registerRecoveryOwnerDevice`, `acknowledgeRecoveryOwnerAlert`, `getRecoveryOwnerPendingAction`, `getRecoveryOwnerActionReadiness`, `createRecoveryOwnerActionOptions`, and `completeRecoveryOwnerPasskeyAction`. It is an explicit override; do not add phone OTP/grant callables to Gate 3.
- WIF configuration: `GCP_WORKLOAD_IDENTITY_PROVIDER` and `STAGING_DEPLOY_SERVICE_ACCOUNT` should be environment variables (secret fallback is supported). The provider must be a full WIF resource name and the deploy identity a service-account email. The workflow validates both before Google authentication.
- Environment secrets: `GOOGLE_SERVICES_JSON_BASE64`, `STAGING_KEYSTORE_BASE64`, `STAGING_KEYSTORE_PASSWORD`, `STAGING_KEY_ALIAS`, and `STAGING_KEY_PASSWORD`.
- The attestation-verifier deployment may additionally require `RECOVERY_ATTESTATION_SERVICE_ACCOUNT`, `ATTESTATION_APP_PACKAGE`, and `ATTESTATION_APP_MIN_VERSION`.
- Staging Secret Manager still contains `PHONE_PEPPER` and `RECOVERY_SIGNING_KEY_PKCS8` because the candidate Functions package includes recovery infrastructure. Their presence is deployment configuration, not Gate 3 SMS qualification.
- The active public key ring must contain `RECOVERY_SIGNING_KEY_ID`. Private signing keys must never be stored in GitHub variables or the repository.

## Automated Gate 3 checks

The workflow deploys the frozen candidate only to staging, validates staging/production project separation, checks WIF configuration, validates `STAGING_FUNCTIONS_BASE_URL`, verifies the configured release signer SHA-256, builds the release APK and matching androidTest APK, verifies their hashes and signer, then probes the configured owner-verification callables with missing and invalid App Check tokens.

These negative probes establish endpoint routing and App Check enforcement; they **do not constitute a successful authenticated Google Sign-In or Email-Link exchange**. Positive end-to-end owner-session qualification requires a staging Firebase owner account and a controlled email-link test delivery/exchange, and must be reported separately rather than inferred from negative probes. The workflow must fail closed if authenticated test credentials or link-delivery setup are unavailable.

Production recovery remains disabled.

## Qualification matrix

| ID | Test | Required result |
|---|---|---|
| G3-01 | Staging deployment and isolation | WIF deploys only to staging; staging project differs from production. |
| G3-02 | Callable origin and signer | Functions origin matches configured staging project/region; APK and androidTest signer match expected SHA-256. |
| G3-03 | Missing App Check | Owner-verification callables reject missing App Check. |
| G3-04 | Invalid App Check | Owner-verification callables reject invalid App Check. |
| G3-05 | Google Sign-In owner identity | Staging Google Sign-In establishes the expected immutable Firebase UID; no client-supplied owner claims are trusted. |
| G3-06 | Passwordless Email-Link exchange | Firebase validates the single-use link; backend validates UID, tenant, verified email and fresh auth, and issues trusted owner session. |
| G3-07 | Wrong owner / tenant / stale session / replay | Rejected fail-closed; no owner session or sensitive action. |
| G3-08 | Session authorization | Sensitive owner actions independently validate trusted session claims, UID, tenant, freshness and attested device. |
| G3-09 | Encryption boundary | Google/email owner verification cannot unwrap or replace DEK; offline Recovery Key remains required. |
| G3-10 | APK evidence | Candidate SHA, APK hashes and signer fingerprints are recorded and match the staging build. |

Gate 3 automated workflow evidence currently covers deployment, project boundary, APK integrity/signer and negative App Check probes. G3-05 through G3-09 require a separately provisioned authenticated staging qualification and must not be marked PASS without evidence from that test.

## Evidence record

Record candidate SHA, staging project ID, APK SHA-256, signer SHA-256, test-run ID, result and reviewer. Never record email addresses, passwordless links, OOB codes, custom tokens, ID tokens, credentials, phone numbers or device serials.

**Exit condition:** automated staging checks pass, and authenticated Google Sign-In + Email-Link owner verification is independently demonstrated for the same candidate SHA before Gate 3 is declared fully qualified. SMS delivery and a physical SMS device are not Gate 3 exit criteria. Gate 2 OTP instrumentation remains required and unchanged.

**Android API floor:** local-first support remains API 23. Hardware-attested recovery enrollment requires API 24 or later. On API 23 recovery enrollment fails closed before modifying existing Keystore aliases.

Staging and verifier deployment workflows remain restricted to `work/p0-storage-hardening`. Gate 4 remains a separate physical-device qualification and is not a Gate 3 SMS test requirement.
