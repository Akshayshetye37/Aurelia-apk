# Aurelia R1 status

**Release:** R1 — local-only PMS  
**Status:** **NOT RELEASE READY**  
**Candidate SHA:** `e7bab3f1b7534c6dcb5321d383744ae2a9bbaf79`  
**Workflow run:** [R1 required checks](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/42612669441) · [PMS source tests and production web packaging](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/42612669139)

This file is committed as an initial status snapshot. The R1 workflow regenerates it from the exact workflow SHA and run metadata after successful validation.

## Required check scope

R1 CI checks out the event SHA explicitly and verifies the checkout SHA, tests release defaults, runs the complete PMS test suite, builds the production web bundle and scans production assets. A successful source/web run does not qualify Android hardware, financial data migration, accounting sign-off, physical devices, signing, backup/restore or production operations.

## Workstream status

| Workstream | Status | Acceptance still required |
|---|---|---|
| 0. Governance | PARTIAL / ADMIN BLOCKED | Protect `main` and `release/r1-local-first-execution`; require one review, exact R1 status check, no force-push and admin enforcement. |
| 1. Local-first data | PARTIAL | Property settings/menu, bookings, expenses, rooms, guests, restaurant tables/open orders, immutable restaurant sales and inventory now have canonical startup hydration or read verification. Restaurant/retail POS stock deductions commit inventory, table orders, append-only movement ledger, recovery snapshot and outbox in one transaction; stock adjustments and inventory retirement are version-checked. Complete remaining domain reads/writes, report projections, shadow comparison, zero mismatches, legacy quarantine, shared IndexedDB/SQLite contract suite and rollback drills. |
| 2. Financial correctness | BLOCKED | Run read-only diagnostic on authorized redacted backup; obtain accounting-owner sign-off; implement append-only integer-paise journal and atomic payment/journal/outbox with idempotency tests. |
| 3. Atomic operations | PARTIAL | Complete checkout, POS sale, stock adjustment, payment approval and refund request as single DB transactions; fault-inject every write step; verify folio/ledger and stock/movement invariants. |
| 4. Android/security | BLOCKED | Complete DEK envelope design/tests, Kotlin compile/unit tests, instrumentation, storage-full/rollback/migration/process-kill tests and two-phone qualification. |
| 5. R1 operations/release | BLOCKED | Offline lifecycle regression, restart reconciliation, owner-controlled signing, exact tagged-SHA build, permissions/flags review and upgrade test. |
| 6. R2/R3 | DEFERRED | Provider sandbox/webhook/refund qualification and sync stay out of R1. |

## Fail-closed release profile

- `uiCutover=false`; sync OFF; gateway entry points OFF; Pay Bridge OFF.
- CCAvenue OFF; enabled provider allow-list empty.
- Automatic settlement and refund posting OFF.
- R1 release publishing NOT AUTHORIZED.

## External evidence required

- Owner-authorized redacted backup and accounting owner's written sign-off.
- Two physical Android phones (one low-end).
- Owner-controlled signing key.
- Repository owner/admin action for branch protection/rulesets.

**Completion rule:** a gate is DONE only with implementation, regression coverage, passing CI on the exact candidate SHA and required external evidence. Documentation and older green runs do not close a gate.
