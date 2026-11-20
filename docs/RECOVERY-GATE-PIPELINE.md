# Recovery Gate 1–6 pipeline

## Branch and trust model

- Control branch for Gates 1, 2, 4, 5, 6 and manual attestations: `integration/ledger-patch` (`GATE_CONTROL_BRANCH`).
- Gate 3 controller branch: `work/gate-3-google-email-link` (separate from the backup implementation PR).
- Frozen candidate branch for all candidate-bound gates: `fix/backup-consolidated-integration` (`CANDIDATE_BRANCH`). The candidate SHA must equal its current HEAD and `gates/qualification-candidate-sha.txt`; moving the branch invalidates all evidence.
- A candidate SHA must equal the current candidate branch head when each gate runs. Moving the branch invalidates the previous qualification evidence.
- Gate 3 is dispatched from its dedicated controller branch; Gates 1, 2, 4, 5, 6 and manual attestations are dispatched from the control branch. Candidate source is checked out only where required and is never checked out or executed on the physical-device runner.
- Gate 3 calls the trusted reusable `recovery-staging-deploy.yml` workflow from the Gate 3 controller revision. It checks out candidate source into a separate `candidate/` directory and runs it only with the staging WIF identity. The Gate 3 WIF provider must trust only the controller repository ID, branch and workflow; the frozen candidate branch receives no WIF authority.
- Gate 4 checks out only trusted control-branch tooling, downloads Gate 3 APKs, verifies their attested hashes, and installs those APKs on the allowlisted physical handset. The self-hosted job has no OIDC permission; a separate hosted job independently re-verifies the APK hashes and attests only sanitized device metadata and log-scan reports.
- Gate 5 uses a dedicated read-only production audit service account. It does not deploy or mutate production.
- Gate 6 only produces `QUALIFIED_FOR_RELEASE_REVIEW`; it does not enable production recovery or change any feature flag.

## Repository variables

Set these at repository or environment scope as indicated:

| Variable | Scope | Purpose |
|---|---|---|
| `GATE_CONTROL_BRANCH` | Repository | `integration/ledger-patch` (Gates 1, 2, 4, 5, 6 and manual attestations) |
| `CANDIDATE_BRANCH` | Repository | `fix/backup-consolidated-integration` |
| `GCP_PROJECT_ID` | `recovery-staging` environment | Staging Firebase/GCP project ID |
| `PRODUCTION_GCP_PROJECT_ID` | Repository / `recovery-production-audit` | Production project ID; must differ from staging |
| `GCP_REGION` | `recovery-staging` environment | Staging Functions region |
| `PRODUCTION_GCP_REGION` | `recovery-production-audit` environment | Production Cloud Run / Functions region |
| `STAGING_FUNCTIONS_BASE_URL` | `recovery-staging` environment | Optional explicit HTTPS callable base URL; Gate 3 derives the regional Cloud Functions URL if empty |
| `GATE3_CONTROL_BRANCH` | Gate 4/6 workflow | `work/gate-3-google-email-link`; Gate 3 evidence controller branch |
| `ATTESTATION_APP_SIGNER_SHA256` | `recovery-staging` environment | Expected release APK signer SHA-256 fingerprint |
| `ATTESTATION_VERIFIER_SERVICE` | `recovery-production-audit` environment | Production Cloud Run attestation verifier service name |
| `REQUIRED_SECRETS` | `recovery-production-audit` environment | Comma-separated Secret Manager secret names |
| `RUNTIME_SERVICE_ACCOUNTS` | `recovery-production-audit` environment | Comma-separated production runtime service-account emails |
| `APPCHECK_REQUIRED_SERVICES` | `recovery-production-audit` environment | Comma-separated Firebase App Check service IDs |
| `DEVICE_SERIAL` | `recovery-device` environment | Dedicated physical handset serial; never written to evidence |
| `DEVICE_SERIAL_ALLOWLIST` | `recovery-device` environment | Comma-separated exact allowlist of permitted handset serials |

## GitHub Actions secrets

- `recovery-staging`: `GCP_WORKLOAD_IDENTITY_PROVIDER`, `STAGING_DEPLOY_SERVICE_ACCOUNT` (staging-project-only WIF identity), `GOOGLE_SERVICES_JSON_BASE64`, `STAGING_KEYSTORE_BASE64`, `STAGING_KEYSTORE_PASSWORD`, `STAGING_KEY_ALIAS`, and `STAGING_KEY_PASSWORD`. The signer fingerprint variable must match this staging keystore. Never expose the production release keystore or production deploy identity to candidate build code.
- `recovery-production-audit`: `GCP_WORKLOAD_IDENTITY_PROVIDER` and **`GCP_AUDIT_SERVICE_ACCOUNT`**. The audit service account must be distinct from all production runtime service accounts and must have read-only access only. Do not reuse the deploy service account.
- `recovery-device`: no production or staging deployment credentials are needed on the self-hosted handset runner.

The staging WIF identity must be scoped to the staging project only, with no production project access. The Gate 3 provider must restrict tokens to immutable repository ID `1438189314`, branch `work/gate-3-google-email-link`, and the named Gate 3 workflow. See `docs/GATE-3-WIF-SETUP.md`. Candidate build/deploy code can access this identity, so do not reuse a production deploy account or production signing keystore. The production audit identity needs read-only permissions sufficient to list Cloud Functions and Cloud Run services, inspect service IAM policies, list Secret Manager versions and IAM policies, inspect service-account keys/IAM, and read Firebase App Check enforcement. It must not have deployment, secret payload access, or production mutation permissions.

## Required environment protections

Configure these environments in GitHub repository Settings → Environments:

- `recovery-staging`: required reviewer approval before staging deployment; staging-only WIF identity and signing secrets.
- `recovery-device`: restrict deployment branches to the control branch and require the dedicated physical-device runner. The runner must provide Node.js 22+, GitHub CLI with `gh attestation verify --deny-self-hosted-runners`, Android platform-tools (`adb`), `jq`, GNU `tar`, and GNU `timeout`.
- `recovery-attestation`: at least one required reviewer; enable **Prevent self-review**.
- `recovery-production-audit`: required reviewer approval; production audit identity only.
- `recovery-release-review-1` and `recovery-release-review-2`: configure separate, preferably disjoint reviewer groups and enable **Prevent self-review** on both. Gate 6 runs these approvals sequentially and independently verifies two distinct approvers from the workflow-run approval history. SMS/device attestation `tester` fields must be GitHub logins, and neither tester may be one of the attestation reviewers or final release approvers.

The Gate 6 approval-history API response must be checked on the first authorized Gate 6 run. Gate 6 fails closed if it does not return two distinct approved reviewers or if the triggering actor is among them.

## Gate sequence

1. Gate 1 verifies encrypted-storage, OTP instrumentation and PMS quality runs on the exact candidate SHA, including positive test-count evidence.
2. Gate 2 verifies payment backend, recovery functions and local-first runs on the exact candidate SHA; it also runs protected-flag/App Check source tripwires and scans the redacted recovery emulator log artifact. Only the redacted scan report is included in Gate 2 evidence.
3. Gate 3 qualifies staging deployment for Google Sign-In + Firebase Passwordless Email-Link owner verification from the dedicated controller branch. It verifies staging/production separation, WIF preflight, staging Functions origin, APK hashes and signer, then probes only the allowlisted email-link callables for missing/invalid App Check. Gate 3 does not deploy or qualify SMS/phone callables. These negative probes do not prove a successful authenticated sign-in/link exchange; positive owner-session qualification must be separately evidenced.
4. Gate 4 verifies Gate 3 provenance from `work/gate-3-google-email-link` and matching candidate/APK hashes, then runs the existing physical recovery instrumentation phases on the allowlisted handset. Raw instrumentation/logcat output is scanned on the dedicated self-hosted device runner, deleted from its job workspace, and never uploaded; only sanitized device metadata and the scan report are retained.
5. Gate 5 checks protected source flags and audits deployed production recovery state, IAM exposure, service-account keys, Secret Manager access and App Check enforcement. Raw IAM policies are not uploaded.
6. Gate 6 verifies all seven evidence records (Gates 1–5 plus SMS and device attestations), the candidate tip, matching APK hashes, evidence freshness and two independent approvals. It produces a release-review qualification record only.

## Protected invariants

`RECOVERY_ENABLED=false`, live collection OFF, automatic settlement OFF, automatic refunds OFF, cloud sync OFF, `uiCutover=false`, and `BT_PRINTING_ENABLED=false` remain unchanged. Legacy Firestore settlement is not modified. No Gate 3–6 workflow is run by this implementation commit.
