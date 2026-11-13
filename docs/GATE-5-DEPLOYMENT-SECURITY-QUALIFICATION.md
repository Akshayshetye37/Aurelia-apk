# Gate 5 — Deployment and security qualification

**Status: NOT EXECUTED.** Source CI is not proof of deployed IAM, App Check, secrets, revocation freshness or production flag state.

## Automated deployment probes

- `Recovery hardware-attestation verifier deploy` deploys Cloud Run without public invocation, grants `roles/run.invoker` only to the configured Functions runtime service account, then checks:
  - no `allUsers` or `allAuthenticatedUsers` invoker binding;
  - unauthenticated `/healthz` is denied;
  - authenticated `/healthz` succeeds only while Google revocation status is fresh;
  - authenticated malformed `/verify` is rejected.
- `Recovery staging deployment and APK` verifies staging Secret Manager secret versions, sets `RECOVERY_ENABLED=true` only in the staging project, binds the verifier service account and builds the staging APK.
- `Verify production recovery remains disabled` is a read-only workflow. It must pass against the production project and confirm every deployed recovery/attestation service has `RECOVERY_ENABLED=false` or the parameter is unset (default false).

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


The staging deploy and read-only production audit workflows resolve the deployed service account for each recovery callable that uses Secret Manager, then verify secret-level `roles/secretmanager.secretAccessor` for exactly the declared secrets. The owner-alert acknowledgement callable explicitly binds `PHONE_PEPPER`; missing runtime secret bindings or IAM grants fail deployment qualification.


The Cloud Run verifier runtime service account (`RECOVERY_ATTESTATION_SERVICE_ACCOUNT`), the Firebase Functions caller service account (`RECOVERY_FUNCTIONS_SERVICE_ACCOUNT`) and the WIF deployment service account (`GCP_DEPLOY_SERVICE_ACCOUNT`) must be three distinct identities. Only the Functions caller receives `roles/run.invoker`; the deploy identity receives `roles/iam.serviceAccountOpenIdTokenCreator` on the caller identity for the authenticated deployment probe.
