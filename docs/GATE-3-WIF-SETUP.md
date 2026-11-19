# Gate 3 Workload Identity Federation setup

Gate 3 uses GitHub Actions Workload Identity Federation (WIF), not a service-account JSON key. The workflow validates the configuration before authentication and never prints credential values.

## GitHub Environment

Configure the repository Environment named `recovery-staging`.

Required values for authentication:

- `GCP_WORKLOAD_IDENTITY_PROVIDER` — full provider resource name:
  `projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID/providers/PROVIDER_ID`
- `STAGING_DEPLOY_SERVICE_ACCOUNT` — staging deploy service-account email, e.g. `name@staging-project.iam.gserviceaccount.com`.

These may be Environment variables or secrets. Prefer variables for non-secret resource identifiers. Do not store a service-account private key or JSON key.

## Google Cloud trust

In the staging Google Cloud project/identity project:

1. Create or reuse a Workload Identity Pool and an OIDC provider for issuer `https://token.actions.githubusercontent.com`.
2. Map GitHub claims to attributes, including repository owner/name, workflow, ref and actor as required by your policy.
3. Restrict the provider's attribute condition to this repository and the trusted Gate 3 control workflow/branch. Do not allow arbitrary branches or forks to impersonate the deploy identity.
4. Grant the staging deploy service account `roles/iam.workloadIdentityUser` to the exact mapped GitHub principal/principalSet.
5. Grant that service account only the staging deployment permissions required by Firebase Functions, Cloud Build, Artifact Registry, Cloud Run, service-account use and Secret Manager. Do not grant production-project access.
6. Ensure the staging project is distinct from the configured production project.

## Other required Gate 3 environment configuration

The workflow validates these values before deployment:

- Variables: `GCP_PROJECT_ID`, `PRODUCTION_GCP_PROJECT_ID`, `GCP_REGION` (default `asia-south1`), `STAGING_FUNCTIONS_BASE_URL`, `RECOVERY_FUNCTIONS_SERVICE_ACCOUNT`, `RECOVERY_ATTESTATION_VERIFIER_URL`, `RECOVERY_SIGNING_KEY_ID`, `RECOVERY_GRANT_PUBLIC_KEYS_JSON`, `FIREBASE_WEB_API_KEY`, `APP_CHECK_PLAY_INTEGRITY_REGISTERED`, `APP_CHECK_SIGNER_SHA256`, `ATTESTATION_APP_SIGNER_SHA256`.
- Secrets: `GOOGLE_SERVICES_JSON_BASE64`, `STAGING_KEYSTORE_BASE64`, `STAGING_KEYSTORE_PASSWORD`, `STAGING_KEY_ALIAS`, `STAGING_KEY_PASSWORD`.
- Secret Manager in staging must contain the recovery secrets expected by the deployment workflow. The public key pin in `RECOVERY_GRANT_PUBLIC_KEYS_JSON` must match the signing key stored in Secret Manager.

Values must be owner-provided and verified. This document intentionally contains no project IDs, account emails, key material or secret values.

## Qualification

1. Save the Environment configuration.
2. Run the Gate 3 trusted control workflow with the frozen candidate SHA.
3. The early configuration validation must pass.
4. WIF authentication must succeed and impersonate only the staging service account.
5. Deployment, service-account/secret access checks, App Check probes and APK qualification must pass.
6. Review uploaded evidence and ensure staging project IDs, signer fingerprints and candidate SHA match. Production recovery flags remain OFF.

If the preflight reports a missing provider or service account, configuration is absent. If the auth action fails after preflight, inspect the provider attribute condition, GitHub claims, principal binding and service-account impersonation permission. Never work around WIF by adding a long-lived JSON key to the repository.
