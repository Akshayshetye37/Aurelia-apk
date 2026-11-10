# Aurelia PMS Production Release Checklist

**Release state:** BLOCKED — do not create an `aurelia-approved-*` tag while any gate below is open.

## Candidate identity

- Approved source commit SHA: **UNASSIGNED**
- Build workflow run: **UNASSIGNED**
- APK SHA-256: **UNASSIGNED**
- APK signing certificate SHA-256: **UNASSIGNED**
- Provenance/attestation reference: **UNASSIGNED**
- Target Android device matrix: see [Android device qualification](ANDROID_DEVICE_QUALIFICATION.md).

## Mandatory technical gates

| Gate | Required evidence | Status |
|---|---|---|
| 1. SQLite instrumentation | Exact-SHA green emulator run; nonzero tests; zero failures/errors/skips; JUnit XML and logcat artifacts | OPEN |
| 2. IndexedDB/SQLite parity | Shared contract and generated operation/property tests pass against both engines; parity check required by ruleset | OPEN |
| 3. PMS domain cutover | Strict domain schemas, transition tables, repository-only persistence, permissions, DB constraints, restart and rollback tests for every domain | OPEN |
| 4. Device security | Same-DEK PIN/biometric/recovery wrappers; OTP isolation; tamper-evident lockout; fail-closed tamper tests | OPEN |
| 5. Physical device qualification | Every supported matrix row passes fault injection, low-storage, reboot and integrity tests; signed tester/reviewer evidence | OPEN |
| 6. Backup and restore | Temporary DB validation, integrity/contract/accounting checks, journaled atomic swap, second-device and interruption tests | OPEN |
| 7. Real PMS migration | Written owner authorization, encrypted snapshot, dry run, zero-variance reconciliation, rollback proof, owner/accounting signatures | OPEN |
| 8. Payments | Per-provider sandbox security/refund tests, replay/idempotency and settlement reconciliation, written provider acceptance | OPEN |
| 9. Governance | Protected ruleset, independent review, signed commit, protected signing environment, exact SHA and provenance | OPEN |
| 10. Operations | Secret scan, PII-safe monitoring, incident runbook and named operational owners | OPEN |

## Feature switches

- `uiCutover`: **OFF**
- Provider live collection: **OFF**
- Auto-settlement: **OFF**
- Auto-refunds: **OFF**
- Production migration: **OFF**
- Production release workflow: **DISABLED** until gates 1–10 are approved.

## Required approvals

| Approval | Name | Date | Evidence |
|---|---|---|---|
| PMS data owner | **UNASSIGNED** | — | — |
| Accounting approver | **UNASSIGNED** | — | — |
| Payment/provider owner | **UNASSIGNED** | — | — |
| Security/key custodian | **UNASSIGNED** | — | — |
| Independent code reviewer | **UNASSIGNED** | — | — |
| Release owner | **UNASSIGNED** | — | — |
| Rollback owner | **UNASSIGNED** | — | — |

## Release procedure

1. Close gates 1–8 with evidence attached to the exact candidate SHA.
2. Configure branch ruleset and protected release environment with required independent reviewers and no bypass.
3. Verify signed commits and secret scanning/push protection.
4. Build only from the approved SHA inside the protected release environment.
5. Verify APK signature and certificate fingerprint.
6. Generate and verify GitHub build provenance attestation.
7. Record source SHA, artifact SHA-256, certificate fingerprint, workflow run and attestation reference.
8. Obtain all named approvals before publishing.
9. Execute the staged rollout with monitoring and rollback owner present.
10. Roll back immediately on database integrity failure, unexplained accounting variance, key-envelope failure, payment ledger mismatch, signature/provenance mismatch or material PII exposure.

## Rollback procedure

- Stop rollout and disable affected provider/cutover flags.
- Preserve the exact release APK, source SHA, attestation and sanitized diagnostics.
- Restore the prior known-good signed build.
- Do not restore a database from an unverified backup.
- If data state changed during rollout, restore through the approved temporary-database validation and reconciliation procedure; do not overwrite the active database blindly.
- Obtain independent confirmation of database integrity and folio/settlement reconciliation before reopening operations.
