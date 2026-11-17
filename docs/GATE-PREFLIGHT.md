# Release preflight

Run this read-only check from a trusted administrator workstation before freezing the candidate or dispatching qualification workflows.

```bash
gh auth status
node scripts/gates/preflight.mjs Akshayshetye37/Aurelia-apk integration/ledger-patch /secure/path/roles.json
```

The GitHub identity must be able to read repository Actions variables/secrets metadata, all seven environment definitions and their protection rules, branch protection, environment deployment branch policies, and the Actions runner inventory. Missing permissions or unreadable configuration fails closed. The script reports names and pass/fail results only; it does not print or persist variable/secret values.

Keep `roles.json` outside the repository and restrict its filesystem permissions. It maps six distinct people:

```json
{
  "maintainer": "<GitHub login>",
  "operator": "<GitHub login>",
  "tester": "<GitHub login>",
  "owner": "<GitHub login>",
  "reviewer1": "<GitHub login>",
  "reviewer2": "<GitHub login>"
}
```

## Required environment configuration

| Environment | Required variables | Required secrets |
|---|---|---|
| `recovery-staging` | `GCP_PROJECT_ID`, `PRODUCTION_GCP_PROJECT_ID`, `GCP_REGION`, `RECOVERY_FUNCTIONS_SERVICE_ACCOUNT`, `RECOVERY_PHONE_SERVICE_ACCOUNT`, `RECOVERY_GRANT_SERVICE_ACCOUNT`, `RECOVERY_ATTESTATION_SERVICE_ACCOUNT`, `RECOVERY_ATTESTATION_VERIFIER_URL`, `RECOVERY_SIGNING_KEY_ID`, `RECOVERY_GRANT_PUBLIC_KEYS_JSON`, `FIREBASE_WEB_API_KEY`, `ATTESTATION_APP_PACKAGE`, `ATTESTATION_APP_MIN_VERSION`, `ATTESTATION_APP_SIGNER_SHA256`, `APP_CHECK_PLAY_INTEGRITY_REGISTERED`, `APP_CHECK_SIGNER_SHA256` | `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_DEPLOY_SERVICE_ACCOUNT`, `STAGING_DEPLOY_SERVICE_ACCOUNT`, `GOOGLE_SERVICES_JSON_BASE64`, `STAGING_KEYSTORE_BASE64`, `STAGING_KEYSTORE_PASSWORD`, `STAGING_KEY_ALIAS`, `STAGING_KEY_PASSWORD` |
| `recovery-device` | `DEVICE_SERIAL`, `DEVICE_SERIAL_ALLOWLIST` | None |
| `recovery-production-audit` | `PRODUCTION_GCP_PROJECT_ID`, one of `PRODUCTION_GCP_REGION` or `GCP_REGION`, `ATTESTATION_VERIFIER_SERVICE`, `ATTESTATION_VERIFIER_CALLER_SERVICE_ACCOUNT`, `REQUIRED_SECRETS`, `RUNTIME_SERVICE_ACCOUNTS`, `APPCHECK_REQUIRED_SERVICES`, `FIREBASE_ANDROID_APP_IDS`, `FIREBASE_ALLOWED_SHA1`, `FIREBASE_ALLOWED_SHA256` | `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_AUDIT_SERVICE_ACCOUNT` |
| `recovery-attestation` | None | None |
| `recovery-release-owner` | `PRODUCTION_GCP_PROJECT_ID`, `PRODUCTION_RECOVERY_SIGNING_KEY_ID`, `PRODUCTION_RECOVERY_GRANT_PUBLIC_KEYS_JSON` | `PRODUCTION_GOOGLE_SERVICES_JSON_BASE64`, `PRODUCTION_KEYSTORE_BASE64`, `PRODUCTION_KEYSTORE_PASSWORD`, `PRODUCTION_KEY_ALIAS`, `PRODUCTION_KEY_PASSWORD` |
| `recovery-release-review-1` | None | None |
| `recovery-release-review-2` | None | None |

The repository variable `RELEASE_OWNER_LOGIN` is also required and must be configured to the designated candidate owner. The preflight checks its presence by name; Gate 6 verifies the actual approved login against this configured value.

## Mandatory scope rules

- `GCP_AUDIT_SERVICE_ACCOUNT` must exist exactly once, as a secret in `recovery-production-audit`. It must not exist at repository scope, in another environment, or as a variable.
- `PHONE_PEPPER` and `RECOVERY_SIGNING_KEY_PKCS8` must not be GitHub Actions variables or secrets at repository or environment scope. They belong in Google Secret Manager.
- All seven environments must require individual reviewers, prevent self-review, disallow administrator bypass and restrict deployments to `integration/ledger-patch`.
- The owner/reviewer environments must each have exactly the assigned individual reviewer. The staging, device, production-audit and attestation environments must exclude the Operator and Tester.
- Branch protection must require PR approval and status checks, dismiss stale approvals, enforce rules for administrators, and disable force-push/deletion.
- Exactly one runner must carry the `aurelia-android-device` label. It must be online before Gate 4 dispatch.

## What this check does not prove

A PASS is a configuration-name and policy preflight, not a live qualification result. It does not verify secret values, GCP IAM, Firebase deployments, Secret Manager payloads, valid Play Integrity tokens, real SMS delivery, hardware attestation, physical handset facts, or the production recovery flag. Gate 3, Gate 4 and Gate 5 perform those live checks. Production `RECOVERY_ENABLED` must remain false.
