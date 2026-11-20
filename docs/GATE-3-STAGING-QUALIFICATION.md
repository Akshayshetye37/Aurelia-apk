# Gate 3 — Google Sign-In + Firebase Email-Link Staging Qualification

**Authoritative scope:** [docs/GATE-3-SCOPE.md](GATE-3-SCOPE.md). Gate 3 qualifies Google Sign-In and Firebase Passwordless Email-Link only. SMS, phone authentication, phone binding, and SMS recovery are excluded.

## Authentication boundary

- **Google Sign-In:** primary account identity. It identifies the owner/account and is separate from local SQLite encryption.
- **Firebase Passwordless Email-Link:** sensitive owner verification. The owner requests a link, Firebase verifies it, and the backend validates immutable owner UID, tenant, verified email, and authentication freshness before issuing a trusted owner session.
- **SMS/phone authentication:** excluded from Gate 3 and from the Gate 3 staging deployment allowlist. Do not deploy or probe phone OTP/change callables for this gate.
- Neither Google Sign-In nor Email-Link session can unwrap, regenerate, or replace the local DEK. The offline Recovery Key remains the cryptographic recovery authority.

## Staging-only configuration

Create GitHub Environment `recovery-staging` and configure:

- Variables: `GCP_PROJECT_ID`, `PRODUCTION_GCP_PROJECT_ID`, `GCP_REGION`, `STAGING_FUNCTIONS_BASE_URL` (HTTPS origin must be exactly `${GCP_REGION}-${GCP_PROJECT_ID}.cloudfunctions.net`), `FIREBASE_WEB_API_KEY`, `APP_CHECK_PLAY_INTEGRITY_REGISTERED=true`, `APP_CHECK_SIGNER_SHA256`, and `ATTESTATION_APP_SIGNER_SHA256` (the last two must match the release APK signer SHA-256).
- WIF configuration: `GCP_WORKLOAD_IDENTITY_PROVIDER` and `STAGING_DEPLOY_SERVICE_ACCOUNT` should be environment variables (secret fallback is supported). The provider must be a full WIF resource name and the deploy identity a service-account email. See [Gate 3 WIF setup](GATE-3-WIF-SETUP.md) for the exact repository/branch/workflow trust boundary and negative qualification.
- Secrets: `GOOGLE_SERVICES_JSON_BASE64`, `STAGING_KEYSTORE_BASE64`, `STAGING_KEYSTORE_PASSWORD`, `STAGING_KEY_ALIAS`, and `STAGING_KEY_PASSWORD`.
- `scripts/gates/callables.json` is the authoritative Gate 3 deployment/probe allowlist. It contains only `exchangeOwnerEmailLink` and `confirmRecoveryOwnerBinding`. The staging workflow deploys these functions individually, not `firebase deploy --only functions`; phone/SMS and recovery-device callables are excluded.
- Staging sets `RECOVERY_ENABLED=true` only to allow the existing Email-Link enrollment callable to operate. No phone/SMS callable is deployed. Production `RECOVERY_ENABLED=false` remains mandatory.
- The workflow validates the Google Services project ID/API key against the configured staging project and verifies the App Check signer matches the expected staging APK signer. No recovery signing key or PHONE_PEPPER is required by this Gate 3 deployment.

## Automated Gate 3 checks

The workflow deploys the frozen candidate only to staging, validates staging/production project separation, checks WIF configuration, validates `STAGING_FUNCTIONS_BASE_URL`, verifies the configured release signer SHA-256, builds the release APK and matching androidTest APK, verifies their hashes and signer, then probes only the two inventory-listed email-link owner callables with missing and invalid App Check tokens.

These negative probes establish endpoint routing and App Check enforcement; they **do not constitute a successful authenticated Google Sign-In or Email-Link exchange**. The current workflow has no positive authenticated test harness. A separate qualification harness must use a staging Firebase owner account and controlled email-link delivery, fail closed when setup is unavailable, and report positive results separately rather than infer them from negative probes.

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

Gate 3 automated workflow evidence currently covers deployment of the two allowlisted email-link callables, project boundary, APK integrity/signer and negative App Check probes. G3-05 through G3-09 require a separately provisioned authenticated staging qualification and must not be marked PASS without evidence from that test.

## Evidence record

Record candidate SHA, staging project ID, APK SHA-256, signer SHA-256, test-run ID, result and reviewer. Never record email addresses, passwordless links, OOB codes, custom tokens, ID tokens, credentials, phone numbers or device serials.

**Exit condition:** automated staging checks pass, and authenticated Google Sign-In + Email-Link owner verification is independently demonstrated for the same candidate SHA before Gate 3 is declared fully qualified. SMS delivery and a physical SMS device are not Gate 3 exit criteria. Gate 2 OTP instrumentation remains required and unchanged.

**Android API floor:** local-first support remains API 23. Hardware-attested recovery enrollment requires API 24 or later. On API 23 recovery enrollment fails closed before modifying existing Keystore aliases.

Gate 3 controller runs from `work/gate-3-google-email-link` and validates a frozen candidate SHA equal to the current HEAD of `fix/backup-consolidated-integration`. The candidate is checked before staging deployment and again before PASS evidence. Gate 3 does not share PR #55's backup changes. Gate 4 remains a separate physical-device qualification and is not a Gate 3 SMS test requirement.


## Retired SMS qualification artifacts

The former `gate-3-real-sms-staging.yml` workflow and `GATE-3-REAL-SMS-STAGING-QUALIFICATION.md` filename are retired. Do not dispatch or use legacy SMS/phone qualification artifacts as Gate 3 evidence. The current workflow is `gate-3-google-email-link-staging.yml`.
