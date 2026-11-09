# Aurelia release status

**Overall:** NOT PRODUCTION READY  
**Release target:** R1 — local-only PMS  
**Execution branch:** `release/r1-local-first-execution`  
**Baseline inspected:** `feature/multi-provider-payment-backend` @ `410175355120c62a3b16a716169fdcf86ef7b6f9`  
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
| R1-A governance plan | IN PROGRESS | Execution branch and release plan created; branch protection still requires live configuration and verification. |
| R1-B domain shadow/cutover | NOT STARTED | Requires per-domain implementation, privacy-safe mismatch telemetry and tests. |
| R1-C financial diagnostic | IMPLEMENTED — CI PENDING | Existing read-only consistency diagnostic and CLI retained; CLI now emits redacted aggregate output by default. Row-level identifiers/references require explicit `--private-report`. Added regression tests for default redaction and opt-in detail. No real backup has been analyzed. |
| R1-C immutable journal | PARTIAL FOUNDATION | Existing local settlement and repository batches exist; single append-only journal and atomic audit/outbox integration not accepted. |
| R1-D Android instrumentation | NOT QUALIFIED | Source compile evidence is not runtime qualification; instrumentation and device evidence outstanding. |
| R1-D physical devices | NOT RUN | Requires at least two supported physical devices. |
| R2 provider | DEFERRED | No provider selected or qualified for R2. |
| R3 sync | DEFERRED | Remains disabled until R1 has real operational evidence. |

## Verified baseline facts
- The audited feature branch contains IndexedDB and native SQLite repository foundations and selected entity/outbox transactions.
- The full UI is not yet on a single canonical repository path; legacy reads/writes remain.
- The canonical financial journal and historical reconciliation are not accepted.
- Payment provider foundations exist, but merchant UAT and verified capture-to-folio posting are not complete.
- The Pay Bridge companion source was not present in the inspected PMS repository checkpoint.
- A source-quality workflow pass is not Android physical-device qualification or production readiness.

## Work implemented on execution branch

- Added the sequential R1 → R2 → R3 release execution plan and single gate ledger.
- Aligned README release direction and corrected the recorded source-quality run to the audited baseline evidence.
- Hardened the existing read-only accounting diagnostic CLI: default stdout is an aggregate-only redacted summary; full row-level report is explicit opt-in via `--private-report`. The diagnostic remains read-only and performs no historical repair.
- Added tests for default suppression of booking/guest/room/payment-reference/idempotency identifiers and explicit private-report behavior.
- These code changes have **not yet been executed in CI**; they remain pending verification.

## Verification log
| Commit / run | Result | Scope |
|---|---|---|
| `410175355120c62a3b16a716169fdcf86ef7b6f9` | BASELINE AUDIT | README and source audit recorded on 2026-11-09. |
| [PMS source-quality run 42495345884](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/42495345884) | PASS (historical baseline) | Node tests, production web build and asset privacy checks; no APK/device qualification. |
| Diagnostic privacy implementation | COMMITTED | Source and regression-test commit: `c75613bcdcba6739e34c505092d2ff727de6c34c`. CI has not yet been run on the execution branch. |

## Next implementation checkpoints
1. Correct native template workflow path filters and prove a template-only change triggers CI.
2. Implement read-only financial diagnostic with synthetic fixtures and non-PII output.
3. Implement per-domain shadow read/compare with legacy display on mismatch.
4. Add Android instrumentation for storage-full, rollback, migration and process-death.
5. Apply branch protection; verify required status checks and review policy.

No production release, merge, signing, live collection, refund posting, Pay Bridge dispatch or sync activation is authorized by this status file.
