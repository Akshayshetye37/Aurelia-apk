# Gate 3 Workload Identity Federation Setup

**Status:** Owner-controlled cloud configuration. Repository code cannot prove the provider condition or IAM binding without live Google Cloud access.

## Trusted workflow identity

Gate 3 controller:

- Repository: `Akshayshetye37/Aurelia-apk`
- Immutable repository ID: `1438189314`
- Branch: `work/gate-3-google-email-link`
- Workflow: `.github/workflows/gate-3-google-email-link-staging.yml`

The frozen candidate is checked out as build/deploy input from `fix/backup-consolidated-integration`. **The candidate branch must not receive WIF deployment authority.** Only the Gate 3 controller workflow branch is trusted.

## Provider configuration

Use GitHub's OIDC issuer `https://token.actions.githubusercontent.com`. Map immutable repository ID and the workflow/ref claims, for example:

```
google.subject=assertion.sub
attribute.repository_id=assertion.repository_id
attribute.ref=assertion.ref
attribute.workflow_ref=assertion.workflow_ref
```

Provider attribute condition (adjust only if the actual GitHub token claims differ; validate by a controlled token-claim inspection):

```
assertion.repository_id == '1438189314' &&
assertion.ref == 'refs/heads/work/gate-3-google-email-link' &&
assertion.workflow_ref == 'Akshayshetye37/Aurelia-apk/.github/workflows/gate-3-google-email-link-staging.yml@refs/heads/work/gate-3-google-email-link'
```

Do not trust the issuer alone. Use immutable repository ID and restrict the branch and workflow. The owner must confirm the exact provider condition in Google Cloud.

## Service-account binding

Grant `roles/iam.workloadIdentityUser` on the staging deployment service account only to the principal representing the mapped repository ID and trusted branch/workflow. Do not grant the pool or repository-wide wildcard access. Review the deploy service account's project roles for least privilege and remove production access.

The workflow expects GitHub Environment `recovery-staging`:

- Variable `GCP_WORKLOAD_IDENTITY_PROVIDER`: full provider resource name.
- Variable `STAGING_DEPLOY_SERVICE_ACCOUNT`: staging deploy service-account email.
- Project variables: `GCP_PROJECT_ID`, `PRODUCTION_GCP_PROJECT_ID`, `GCP_REGION`, `STAGING_FUNCTIONS_BASE_URL`, `FIREBASE_WEB_API_KEY`, `APP_CHECK_PLAY_INTEGRITY_REGISTERED`, `APP_CHECK_SIGNER_SHA256`, and `ATTESTATION_APP_SIGNER_SHA256` (expected APK signer fingerprint).
- Secrets: `GOOGLE_SERVICES_JSON_BASE64`, `STAGING_KEYSTORE_BASE64`, `STAGING_KEYSTORE_PASSWORD`, `STAGING_KEY_ALIAS`, and `STAGING_KEY_PASSWORD`.

The staging deploy workflow deploys only the callable allowlist in `scripts/gates/callables.json`. It must never deploy to the production project.

## Required negative qualification

Before Gate 3 can qualify:

1. Run from the exact trusted branch/workflow; authentication must succeed.
2. Run a controlled test from an unauthorized branch and from a fork; both must fail before obtaining Google Cloud credentials.
3. Verify the service-account IAM binding contains only the intended principal.
4. Verify the provider condition and mapped claims directly in Google Cloud.
5. Review inherited project/org IAM and verify the staging service account has no production access.
6. Capture sanitized run evidence and exact SHA. Do not record OIDC tokens, access tokens, credentials or secrets.

## Historical failures

Runs [44505319033](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/44505319033) and [44397260341](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/44397260341) failed at the Workload Identity Federation authentication step. Their logs show the auth action rejected the invocation because it received neither `workload_identity_provider` nor `credentials_json`. The workflow preflight accepted GitHub Environment variables/secret fallback, but the auth action inputs were wired to secrets only. This is a **workflow input-wiring defect**, not merely cloud configuration. PR #62 fixes the auth action inputs to use the same variable-first, secret-fallback expression as preflight. The actual provider condition, service-account binding, unauthorized-branch/fork negative tests, and production IAM review remain unverified.

## References

- [Google Cloud — Workload Identity Federation with deployment pipelines](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines)
- [Google Cloud — Workload Identity Federation best practices](https://docs.cloud.google.com/iam/docs/best-practices-for-using-workload-identity-federation)
