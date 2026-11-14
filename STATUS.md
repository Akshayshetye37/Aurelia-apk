# Aurelia R1 status

**Release:** R1 — local-only PMS  
**Status:** **NOT RELEASE READY**  
**Generated from:** `feature-registry.json`

## Feature registry (source of truth)

- Baseline branch: `feature/multi-provider-payment-backend`
- Baseline SHA: `3fc72fd6b6f69e59c8cbc7441c04624acc455723`
- Implementation entries: 125
- VERIFIED: 0
- LOCKED: 0
- UNVERIFIED: 125

| Feature area | Entries | Verified | Locked | Unverified |
|---|---:|---:|---:|---:|
| android-device-security | 10 | 0 | 0 | 10 |
| android-native-integrations | 12 | 0 | 0 | 12 |
| application-services | 1 | 0 | 0 | 1 |
| booking-lifecycle | 1 | 0 | 0 | 1 |
| build-and-maintenance-tools | 8 | 0 | 0 | 8 |
| device-attestation | 1 | 0 | 0 | 1 |
| legacy-ui-and-pms-entrypoint | 1 | 0 | 0 | 1 |
| local-first-storage | 23 | 0 | 0 | 23 |
| local-payment-and-settlement | 30 | 0 | 0 | 30 |
| optional-cloud-sync | 1 | 0 | 0 | 1 |
| optional-payment-backend | 37 | 0 | 0 | 37 |

## Unified test policy

- Test file scope: tests/**/*.test.{mjs,js,cjs}, payment-backend/test/**/*.test.{mjs,js,cjs}
- Minimum executed tests: 784
- Acceptance: exact candidate SHA; non-zero tests; zero failures; zero skipped; executed count at or above registry minimum.

## Release defaults (must remain OFF)

- `RECOVERY_ENABLED=false`
- `uiCutover=false`; cloud sync OFF; Pay Bridge OFF.
- Live collection OFF.
- Automatic settlement and refund posting OFF.
- R1 release publishing NOT AUTHORIZED.

## External qualification still required

- Repository owner/admin: branch protection, required code-owner review, required reviewers for `aurelia-release-approval`.
- Staging Firebase project, HTTPS hostname, asset links and real certificate pin rotation evidence.
- Authorized redacted accounting backup and accounting-owner written mapping approval.
- Provider sandbox credentials stored only in Secret Manager/GitHub secrets.
- Physical Android device and test SIM; Pay Bridge repository and paired-device validation.
- Owner-controlled signing key and written release signoff.

**Completion rule:** documentation and aggregate CI success do not promote individual features. Each registry entry requires exact-SHA evidence and its own matching test evidence before VERIFIED; immutable hash/tag and code-owner controls before LOCKED.
