# Gate 5 — Deployment and security qualification

**Status: NOT EXECUTED.** Source CI is not proof of deployed IAM, App Check, secrets, revocation freshness or production flag state.

## Automated deployment probes

- `Recovery hardware-attestation verifier deploy` deploys Cloud Run without public invocation, grants `roles/run.invoker` only to the configured Functions runtime service account, then checks:
  - no `allUsers` or `allAuthenticatedUsers` invoker binding;
  - unauthenticated `/healthz` is denied;
  - authenticated `/healthz` succeeds only while Google revocation status is fresh;
  - authenticated malformed `/verify` is rejected.
- `Recovery staging deployment and APK` verifies staging Secret Manager secret versions, sets `RECOVERY_ENABLED=true` only in the staging project, binds the verifier service account and builds the staging APK.
- `.github/workflows/gate-5-production-security.yml` is the canonical read-only Gate 5 workflow. It must pass against the production project and confirm every deployed recovery/attestation service has `RECOVERY_ENABLED=false` or the parameter is unset (default false), validate IAM/Secret Manager/App Check and verify the production Firebase Android signing inventory.

## Android App Check bootstrap

The generated Android application installs Firebase App Check with the Play Integrity provider in its custom `Application.onCreate`, before Firebase Auth, Functions or Messaging use the default app. Missing Firebase configuration does not block local PIN/biometric use; recovery calls remain fail-closed because the callable endpoints enforce App Check.

Before staging, register package `com.aurelia.pms` in Firebase App Check with the Play Integrity provider, link the Play Integrity API to the same Google Cloud project, and register the release signing certificate SHA-256 used by the staging APK. The staging environment must set `APP_CHECK_PLAY_INTEGRITY_REGISTERED=true` and `APP_CHECK_SIGNER_SHA256`; the workflow compares this fingerprint with `ATTESTATION_APP_SIGNER_SHA256` before building.

If the APK is distributed outside Google Play, configure the App Check Play Integrity app registration so it does not require the `PLAY_RECOGNIZED` or `LICENSED` verdicts that sideloaded builds cannot satisfy; apply the intended device-integrity threshold explicitly. Do not enable a debug provider in release builds. Register any debug token only in the staging Firebase project and verify that the same token is rejected by production. Emulator callable-runtime tests invoke Firebase Functions handlers directly and do not constitute App Check verification.

## Remaining staging security probes

1. Missing and invalid App Check tokens must be rejected by every recovery callable.
2. A staging debug App Check token must be accepted only in the staging project; it must never be configured in production.
3. Missing verifier URL, invalid IAM, invalid certificate chain, stale Google revocation data, software-only attestation and unlocked/unverified boot must all fail closed.
4. Verify rate-limit lockouts by phone, tenant, device and IP; confirm retry-after behavior and privacy-safe logs.
5. Rotate the ES256 key: publish old+new public pins in the staging APK, switch the staging active kid/private key, prove new grants verify, allow old five-minute grants to expire, then remove the old pin in a later APK. Never reuse a kid.
6. Inspect Cloud Run, Functions and Android logs for OTP, raw phone, ID token, grant, PIN, recovery key or DEK leakage.

Record immutable run URLs, exact SHA, project, service account identities, APK fingerprints and redacted probe outcomes. Do not copy secrets or token values into evidence. Production recovery stays disabled.


## Deployment probe identity prerequisite

The attestation deployment workflow probes the private Cloud Run service as the **Functions runtime service account**, not as the GitHub deploy identity. Grant the GitHub staging deploy service account only `roles/iam.serviceAccountOpenIdTokenCreator` on the Functions runtime service account. The workflow verifies this narrow binding and obtains a short-lived audience-bound OIDC token by impersonating the runtime identity. It does not grant the deploy identity Cloud Run invoker access.


## Staging App Check probes

The staging deploy workflow sends missing-token and malformed-token callable requests to each recovery endpoint and requires HTTP 401/403 before it builds the APK. A valid Play Integrity token must be exercised from a real staging handset; emulator/source tests are not a substitute. Never register a debug App Check token in production. If a debug provider is needed for isolated staging diagnostics, its token must be registered only in the staging Firebase project and removed after testing.


The Cloud Run verifier runtime service account, Firebase Functions caller service account and staging deploy service account must be three distinct identities. The deploy account needs only the OIDC-token-creator role on the Functions caller account for the authenticated verifier probe; it must not be added as a Cloud Run invoker.


**Staging/production separation:** Configure `PRODUCTION_GCP_PROJECT_ID` in the `recovery-staging` GitHub Environment. Both staging deployment workflows fail if `GCP_PROJECT_ID` equals that production project ID. Do not reuse the production Firebase project, signing private key or test phone numbers in staging.


The read-only production flag audit also requires `GCP_PROJECT_ID` to equal `PRODUCTION_GCP_PROJECT_ID` in the `recovery-production-audit` GitHub Environment. This prevents a successful audit against the staging project from being mistaken for production evidence.


The staging deploy and read-only production audit workflows resolve the runtime identity for every one of the 19 exported recovery callables, including phone registration, owner alert acknowledgement, grant issuance/consumption and cancellation endpoints. Functions may share an identity only when their declared Secret Manager secret sets are identical. The phone-registration pair uses `RECOVERY_PHONE_SERVICE_ACCOUNT` with `PHONE_PEPPER`; the grant-issue/consume pair uses `RECOVERY_GRANT_SERVICE_ACCOUNT` with `PHONE_PEPPER` and `RECOVERY_SIGNING_KEY_PKCS8`; no-secret callables must not share either secret-bearing identity. The owner-alert acknowledgement and passkey callables do not consume `PHONE_PEPPER` and must not inherit access through a shared runtime identity. Gate 5 compares exact secret accessor sets and fails on missing functions, shared identities across different secret sets, excess access or missing allowlisted runtime identities.


The Cloud Run verifier runtime service account (`RECOVERY_ATTESTATION_SERVICE_ACCOUNT`), the Firebase Functions caller service account (`RECOVERY_FUNCTIONS_SERVICE_ACCOUNT`) and the WIF deployment service account (`GCP_DEPLOY_SERVICE_ACCOUNT`) must be three distinct identities. Only the Functions caller receives `roles/run.invoker`; the deploy identity receives `roles/iam.serviceAccountOpenIdTokenCreator` on the caller identity for the authenticated deployment probe.

## Firebase production identity controls (read-only)

The `recovery-production-audit` environment must define `FIREBASE_ANDROID_APP_IDS` (comma-separated exact IDs for every active Android app in the production Firebase project), `FIREBASE_ALLOWED_SHA1`, and `FIREBASE_ALLOWED_SHA256` (complete approved fingerprint inventories). Gate 5 lists every active Android app, requires the exact configured app inventory and `com.aurelia.pms` package, then compares each app's SHA-1 and SHA-256 certificate sets exactly against the approved allowlists. The attested Gate 5 evidence retains the approved SHA-256 certificate hashes, and Gate 6 requires the exact Gate 3 APK signer fingerprint to appear in that production Firebase inventory. Missing/extra apps, missing fingerprints, unapproved fingerprints, or incomplete allowlists fail closed.

The audit separately reads Firebase Auth project configuration and every Identity Platform tenant configuration. Any configured `testPhoneNumbers` entry fails the production audit. Only counts are written to evidence; phone numbers and fake verification codes are never persisted. The audit identity requires read-only Firebase Management and Identity Platform configuration permissions, including `firebase.clients.list`, `firebase.clients.get`, `firebase.projects.get`, `firebaseauth.configs.get`, and `identitytoolkit.tenants.list` / `identitytoolkit.tenants.get`; insufficient access fails the gate. The separate `firebaseauth.configs.getHashConfig` permission is not needed for test-number visibility and should not be granted solely for this audit. Firebase Phone Auth remains the OTP verifier. The backend's `PHONE_PEPPER` HMAC of the registered recovery-phone identifier is a separate control.


## Exact Gate 5 environment configuration

In the protected `recovery-production-audit` environment, configure variables `PRODUCTION_GCP_PROJECT_ID`, `PRODUCTION_GCP_REGION` (or `GCP_REGION`), `ATTESTATION_VERIFIER_SERVICE`, `ATTESTATION_VERIFIER_CALLER_SERVICE_ACCOUNT` (the exact production Functions caller identity; it must also appear in `RUNTIME_SERVICE_ACCOUNTS`), `REQUIRED_SECRETS`, `RUNTIME_SERVICE_ACCOUNTS`, `APPCHECK_REQUIRED_SERVICES`, `FIREBASE_ANDROID_APP_IDS`, `FIREBASE_ALLOWED_SHA1` and `FIREBASE_ALLOWED_SHA256`. Configure secrets `GCP_WORKLOAD_IDENTITY_PROVIDER` and `GCP_AUDIT_SERVICE_ACCOUNT`. The audit identity must be read-only, separate from every runtime identity, have no Secret Manager payload/admin access, and have the Firebase Management, Firebase Auth/Identity Platform and Cloud Run/IAM read permissions required by the audit. `RUNTIME_SERVICE_ACCOUNTS` must enumerate every distinct deployed runtime identity used by the 19 exported recovery callables, including the no-secret identity/identities, `RECOVERY_PHONE_SERVICE_ACCOUNT`, and `RECOVERY_GRANT_SERVICE_ACCOUNT`; it must not include the audit identity. `REQUIRED_SECRETS` must include exactly `PHONE_PEPPER` and `RECOVERY_SIGNING_KEY_PKCS8` for this recovery implementation.

The audit checks project-level invocation grants, resource-level IAM for every first-generation Cloud Function, and Cloud Run service IAM for every second-generation function/service. It also requires the private attestation verifier's `roles/run.invoker` policy to contain exactly the configured `ATTESTATION_VERIFIER_CALLER_SERVICE_ACCOUNT` and no other principal. Project-level Cloud Run/Functions invoker and Secret Manager payload/write grants are rejected because they bypass the resource-scoped IAM boundaries. It rejects public `roles/run.invoker` and first-generation `roles/cloudfunctions.invoker` grants, and requires a complete IAM-policy read for every applicable resource. It does not treat App Check-protected Firebase callable endpoints as equivalent to a public Cloud Run verifier.
