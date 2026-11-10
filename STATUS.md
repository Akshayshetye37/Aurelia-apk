# Aurelia R1 status

**Release:** R1 — local-only PMS  
**Status:** **NOT RELEASE READY**  
**Engineering branch:** `work/p0-storage-hardening`  
**Verified code candidate:** `0ff3ee721e915e5d573252c6b17e22f5df91a1fd`  
**PR:** [#18 — draft, open, unmerged](https://github.com/Akshayshetye37/Aurelia-apk/pull/18)

## Implemented

- IndexedDB browser persistence and native SQLCipher-backed SQLite storage boundaries.
- Preference-only Web Storage whitelist; business state is not stored in localStorage/sessionStorage.
- Local identity stored in IndexedDB only, with validation and fail-closed handling.
- Photo archive, backup vault and payment journal/evidence stores isolated behind storage adapters.
- Canonical authority guards on bootstrap/restore, operational mutation and legacy settlement paths.
- Local-first write coordinator serializes canonical writes and verifies exact read-back; legacy business-state cache writes removed.
- Payment domain settlement requires backend-verified authorization; gateway activation remains OFF.
- Native SQLCipher configuration, encrypted migration, transaction rollback and migration-checkpoint fault-injection tests.

## Partial / requires further verification

| Workstream | Current state | Evidence still required |
|---|---|---|
| Source/web | Previous candidate passed 542 tests, production web build and privacy checks | Rerun exact-head CI after current code change |
| Android SQLite | Native compile, ABI/APK checks, AVD creation and emulator boot succeeded on previous candidate; instrumentation began but was superseded before completion | Exact-head run with nonzero completed tests, XML reports, diagnostics and uploaded artifacts |
| Cross-platform persistence | Separate browser/native implementations exist | Shared SQLite/IndexedDB parity contract suite |
| Migration recovery | SQL rollback and checkpoint fault-injection coverage exists | Process-kill/restart tests and physical-device qualification |
| Domain CRUD | Repository/BaseRepo/Zod foundations and guarded mutation paths exist | Uniform end-to-end routing and optimistic-version coverage across every domain |

## Missing release acceptance

- Physical-device process-death, reauthorization, migration and restart qualification.
- Owner-authorized production-shaped PMS snapshot migration, entity parity and financial rollback.
- Second-device encrypted backup/restore.
- Written accounting-owner sign-off.
- Branch protection and required checks configured by repository owner/admin.
- Owner-controlled production signing and explicit release authorization.

## Fail-closed release profile

- `PREPARED_COMPATIBILITY`; canonical authority is not activated.
- `uiCutover=false`.
- Cloud sync OFF.
- Live gateway collection OFF.
- Automatic settlement OFF.
- Automatic refund posting OFF.
- Provider activation OFF.
- Production publishing NOT AUTHORIZED.

## Legacy data retention

Legacy business keys must remain quarantined until migration has been verified, the required retention delay has elapsed and explicit approval is recorded. No legacy key deletion is authorized by this change.

**Completion rule:** a gate is DONE only with implementation, regression coverage, passing CI on the exact candidate SHA and required real-world evidence. Synthetic fixtures, source templates and older green runs do not close a gate.
