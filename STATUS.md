# Aurelia R1 status

**Release:** R1 — local-only PMS  
**Status:** **NOT RELEASE READY**  
**Engineering branch:** `work/p0-storage-hardening`  
**Engineering branch head:** `c69626abf66164581927c9c6834723f977547de7`  
**Code verification SHA:** `850bdcb7ab8e7c76648591f952c2543e1524040a`  
**Exact-head CI:** [PMS source/web #2678](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/42628507298) · [R1 required checks #153](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/42628507418) · [settlement foundation #737](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/42628507240) · [payment backend #734](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/42628507184) — **all four passed on the exact engineering branch head**.

## Latest implemented increment

- Added typed storage quota/full errors and native SQLite integrity/foreign-key/durability settings.
- Added a storage bypass ratchet and isolated write-fault injection tests.
- Converted settlement journal state transitions and authorization renewals to append-only v3 events; added concurrency and migration tests.
- Added persisted PMS authority state. Bootstrap records `PREPARED_COMPATIBILITY`, records domain projection status, and fails closed if canonical authority is already active. It does **not** activate canonical authority or enable UI cutover.
- New migration identities use SHA-256 (64 hex characters). Existing 8-hex FNV migration markers remain accepted for upgrade compatibility; no new short identifiers are generated.
- The exact-head PMS workflow passed the full Node suite, production web packaging and asset privacy scan. R1, settlement and payment-backend workflows also passed.

The four passing workflows are source/CI evidence only. They do not qualify physical Android devices, real financial migration, accounting sign-off, owner signing, backup/restore drills or production operations.

---

## Historical release-candidate evidence (superseded by the engineering-branch verification above)

The earlier candidate SHA was `6540efb109d62c74ccdf85f361569335fb30ea63`. Its prior R1, PMS source/web and settlement checks passed, but those runs are not used as evidence for the current engineering branch.

## Workstream status

| Workstream | Status | Acceptance still required |
|---|---|---|
| 0. Governance | PARTIAL / ADMIN BLOCKED | Protect `main` and `release/r1-local-first-execution`; require one review, exact R1 status check, no force-push and admin enforcement. Both branches are currently unprotected. |
| 1. Local-first data | PARTIAL | Canonical repository foundations and selected settings, rooms, guests, bookings, expenses, inventory and restaurant projections/transactions exist. Complete every domain's read/write routing, shadow comparison with legacy-value visibility on mismatch, zero-mismatch acceptance, delayed legacy quarantine, shared IndexedDB/SQLite contract suite, and per-domain rollback drills. |
| 2. Financial correctness | BLOCKED | Run the read-only diagnostic on an owner-authorized redacted backup and obtain accounting-owner written sign-off. Only then implement/accept the canonical append-only integer-paise journal, derived balances/receipts/booking paid projection, atomic payment+journal+outbox and command idempotency/property/concurrency tests. |
| 3. Atomic operations | PARTIAL | POS/restaurant and selected inventory transaction foundations exist. Complete checkout, POS sale, stock adjustment, payment approval and refund request transaction boundaries, fault-inject every write step, and assert folio=ledger and stock=movement invariants. |
| 4. Android/security | BLOCKED | Complete native DEK envelope integration (PIN, CryptoObject/BIOMETRIC_STRONG and recovery key wrap the same DEK; OTP cannot touch it), Kotlin compile/unit checks, emulator instrumentation, storage-full/rollback/migration/process-kill tests and two-phone qualification. |
| 5. R1 operations/release | BLOCKED | Complete full offline PMS lifecycle regression and restart journal reconciliation; build a signed APK from a tagged SHA using the owner-controlled signing key; verify package/permissions/flags; perform previous-build upgrade and rollback tests. |
| 6. R2/R3 | DEFERRED | Provider sandbox/webhook/refund qualification, Pay Bridge and sync remain out of R1. |

## Fail-closed release profile

- `uiCutover=false`; cloud sync and local sync are OFF.
- Gateway payments and Pay Bridge are OFF; CCAvenue is OFF; enabled-provider allow-list is empty.
- Automatic settlement, live collection, native settlement bridge and automatic refund posting remain locked.
- R1 release publishing is NOT AUTHORIZED.

## External evidence required

- Owner-authorized redacted backup and accounting owner's written sign-off.
- Two physical Android phones (one low-end) and supported OS versions.
- Owner-controlled release signing key.
- Repository owner/admin action to configure branch protection/rulesets.

## Exact-SHA verification evidence

- R1 run #148: exact checkout assertion, release-default test, full PMS test suite, production web build and production asset privacy scan all passed.
- PMS run #2672: exact candidate assertion, release-default test, full PMS test suite, production web build/privacy scan, web artifact upload and generated status artifact all passed.
- Settlement-foundation: syntax checks, full application test suite and production web assets build passed.
- Generated web artifact SHA: `6540efb109d62c74ccdf85f361569335fb30ea63`; artifact digest: `sha256:bcc2a95fcc03bde9a961556c0960c8fc4ca6d4ba633f1f5c15c5a5e50a25b656`.

**Completion rule:** a gate is DONE only with implementation, regression coverage, passing CI on the exact candidate SHA and required real-world evidence. Documentation, mocks, source templates and older green runs do not close a gate.
