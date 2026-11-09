# Aurelia release status

**Overall:** NOT PRODUCTION READY  
**Release target:** R1 — local-only PMS  
**Execution branch:** `release/r1-local-first-execution`  
**Current execution head at last verification:** `c4ec16c2ae042468bf2c246aa663270aa2a5fb6e` (this status update is a subsequent governance change)  
**Status date:** 2026-11-09

## Release switches — must remain OFF

| Capability | State | Enablement authority |
|---|---|---|
| Global `uiCutover` | OFF | R1 domain gates + owner approval |
| Live gateway collection | OFF | R2 provider gate + explicit owner approval |
| Automatic settlement | OFF | R2 verified capture-to-journal gate + approval |
| Automatic refund posting | OFF | R2 refund/reversal gate + approval |
| Pay Bridge dispatch | OFF / excluded from R1 | Companion source and IPC qualification |
| Cloud sync transport | OFF | R3 sync gate + approval |
| Production signing/publishing | NOT AUTHORIZED | Exact approved release candidate and owner-controlled signing |

## Gate ledger

| Gate | State | Evidence / blocker |
|---|---|---|
| R1-A governance plan | PARTIAL — REPOSITORY RULES BLOCKED | Workflow now includes Java/Kotlin native-template paths. Branch protection on the execution branch is reported disabled. Reading `main` protection returned HTTP 403 from the connected integration; no protection change is claimed. A direct-push rejection test remains unverified. |
| R1-B domain shadow/cutover | NOT STARTED | Requires per-domain implementation, privacy-safe mismatch telemetry, two-week observation and rollback tests. |
| R1-C read-only financial diagnostic | IMPLEMENTED — SYNTHETIC COVERAGE PARTIAL | Existing diagnostic and CLI are read-only; default output is aggregate/redacted and row-level detail requires explicit `--private-report`. Synthetic tests cover multiple integrity categories. A complete packet-2 fixture matrix and authorized redacted real-backup review/sign-off are not evidenced here. |
| R1-C immutable journal | PARTIAL FOUNDATION | Existing local settlement and repository batches exist; single append-only journal and atomic audit/outbox integration are not accepted. |
| R1-D Android instrumentation | NOT QUALIFIED | Source compile evidence is not runtime qualification; instrumentation and device evidence outstanding. |
| R1-D physical devices | NOT RUN | Requires at least two supported physical devices, including one low-end device. |
| R2 provider | DEFERRED | No provider selected or qualified for R2. |
| R3 sync | DEFERRED | Remains disabled until R1 has real operational evidence. |

## Verified evidence

- Source/test CI run [42569418219](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/42569418219) passed on exact source/test SHA `9796ed84eaa2041a76b81354e410be7fc4bb162e`: syntax checks, full application suite (433/433) and production web build.
- The passing run predates the documentation-only commits that produced the previously recorded execution head `c4ec16c2ae042468bf2c246aa663270aa2a5fb6e`; it is not evidence for later commits until CI reruns.
- Earlier run [42569280165](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/42569280165) exposed one failing private-report fixture; the fixture was corrected before the passing run above.
- Previous Android source build evidence is not a physical-device qualification and is not substituted for runtime instrumentation.

## Packet 1 — governance

- [x] Correct stale diagnostic CI state: this ledger now records the exact SHA and scope of the passing run rather than saying CI is pending.
- [x] Add Java and Kotlin native-template paths to settlement CI push and pull-request filters.
- [x] Prove a Java-template-only PR triggers the workflow: [run 42576505089](https://github.com/Akshayshety37/Aurelia-apk/actions/runs/42576505089) completed PASS on exact probe SHA `cf7eeea07584009d1077ac986a05dc2ba15f11c8`; the changed Java template was the only new file in that commit.
- [ ] Verify required checks and reject direct pushes to the protected release branch; not verified.
- [ ] Verify protection on `main`; the connected integration returned HTTP 403 for the protection endpoint.
- [ ] Generate this ledger from machine-readable CI results; not implemented. This file is a manually maintained gate ledger and must not be represented as CI-generated.

## Packet 2 — read-only financial diagnostic

Existing code is read-only and does not repair historical records. Remaining acceptance work:
- Complete explicit fixtures for duplicate payment identities/references, orphaned reservation advances, negative/invalid balances and paid-total mismatches.
- Verify strict mode exits non-zero for each integrity category.
- Run only against an owner-authorized, redacted backup; retain the report under controlled access.
- Obtain accounting-owner review/sign-off. No real backup review or sign-off is claimed.

## Release boundary

R1 remains local-only. Gateway collection, automatic settlement/refunds, Pay Bridge dispatch, cloud sync, global UI cutover and production signing/publishing remain OFF or unauthorized. No historical migration or repair is authorized by this file.
