# Android physical-device qualification record

**Status: NOT EXECUTED — TEMPLATE ONLY.** No device result is implied by this document. Emulator CI is not physical-device qualification.

## Data-handling controls

- Use synthetic PMS fixtures only. Do not copy customer, guest, employee, payment, booking, identity or production database data onto test devices.
- Use test merchant accounts and non-production provider credentials only.
- Record device serial only in the access-controlled test evidence store; use a redacted device label in this repository.
- Encrypt retained logs and database artifacts. Remove them under the approved test-retention policy.

## Device matrix

| Device label | Manufacturer/model | Android version/API | Build fingerprint | SoC/security level | StrongBox available | Test run ID | Result | Evidence reference | Tester signature/date | Reviewer signature/date |
|---|---|---|---|---|---|---|---|---|---|---|
| DEVICE-01 | TBD | TBD | TBD | TBD | TBD | NOT RUN | NOT QUALIFIED | — | — | — |
| DEVICE-02 | TBD | TBD | TBD | TBD | TBD | NOT RUN | NOT QUALIFIED | — | — | — |
| DEVICE-03 | TBD | TBD | TBD | TBD | TBD | NOT RUN | NOT QUALIFIED | — | — | — |

The release owner must approve the supported Android version and device matrix before testing. Include at least one supported lower-end device, one current device, and one StrongBox-capable device where the hardware supports it.

## Required qualification cases

| ID | Scenario | Required evidence | Status |
|---|---|---|---|
| AND-01 | Fresh install and PIN enrollment | App build SHA, device/API, enrollment result | NOT RUN |
| AND-02 | Correct PIN and biometric unlock | Authenticated CryptoObject result; same database identity | NOT RUN |
| AND-03 | Wrong PIN, lockout and reboot | Attempt counters, cooldown persistence, fail-closed result | NOT RUN |
| AND-04 | Process kill during entity/outbox transaction | `adb shell am kill`/`force-stop`, restart, row/outbox atomicity | NOT RUN |
| AND-05 | Process kill at each migration checkpoint | Fault checkpoint, process exit, restart and deterministic recovery | NOT RUN |
| AND-06 | WAL recovery after force-stop/reboot | `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, entity/outbox parity | NOT RUN |
| AND-07 | Low-storage write failure | Device free-space evidence, typed failure, no false success or RAM fallback | NOT RUN |
| AND-08 | Corrupted encrypted database | Fail-closed startup; original bytes retained; no auto-wipe | NOT RUN |
| AND-09 | Key-envelope corruption/Keystore invalidation | Fail-closed unlock; recovery procedure; no regenerated DEK | NOT RUN |
| AND-10 | Backup restore on second physical device | Wrong-key/tamper/interruption checks and entity/attachment/financial parity | NOT RUN |

## Sign-off

A case passes only when the tester attaches timestamped logs and reproducible steps, and a second reviewer signs the result. Record failures and reruns as separate immutable entries. A summary spreadsheet or unsigned checklist is not acceptance evidence.

- Test owner: NOT ASSIGNED
- Independent reviewer: NOT ASSIGNED
- Supported device matrix approval: PENDING
- Security owner approval: PENDING
- Release approval: NOT AUTHORIZED
