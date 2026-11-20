# Aurelia repository structure

This is a local-first PMS with a web UI, Android native bridge, storage/recovery infrastructure, payment backend and release qualification workflows.

## Top-level layout

| Path | Responsibility |
|---|---|
| `index.html` | PMS WebView UI and application orchestration. |
| `src/` | Modular application logic: backup, bookings, features, payments, services, storage, sync. |
| `src/storage/` | Repository adapters, persistence, backup vault and canonical storage boundaries. |
| `src/backup/` | Encrypted backup adapters and owner-controlled destinations; Google Drive work is in PR #55. |
| `android/templates/` | Generated Android Java/Kotlin templates, native bridge, recovery/security and instrumentation sources. |
| `scripts/` | Android/Web packaging, patching, qualification helpers and release tooling. |
| `scripts/gates/` | Gate scripts for candidate validation, evidence, flag audits, log scanning and staging probes. |
| `tests/` | Node unit/regression tests and source-boundary tests. |
| `tests/storage/`, `tests/services/`, `tests/sync/` | Focused storage, service and synchronization test suites. |
| `functions/` | Firebase Functions recovery/backend source, tests and deployment scripts. |
| `payment-backend/` | Payment platform/backend modules: providers, intents, devices, controls, webhooks, settlement, workers, secrets and qualification. |
| `payment-backend/infra/terraform/` | Infrastructure-as-code. |
| `docs/` | Architecture, release qualification, backup, security and audit documents. |
| `.github/workflows/` | CI, Android instrumentation, security gates and release qualification workflows. |
| `assets/` | UI and application assets. |
| `gates/` | Gate evidence/qualification support. |

## Core data and release boundaries

- **Local-first PMS:** device/browser storage is the normal operational path. Cloud connection is opt-in.
- **Backup:** snapshots are encrypted before they leave the PMS storage boundary. Google Drive uses the connected owner's account and hidden App Data; SAF remains a separate explicit file destination.
- **Payment backend:** separate from PMS backup and local operational data. Live collection/automatic settlement/refund posting remain release-gated.
- **Recovery:** recovery services and staging deployment are controlled by Gate workflows. Production recovery flags remain OFF.
- **Build:** Android is generated from templates and patched by scripts; inspect the template/patch/package flow rather than editing generated output as the source of truth.
- **Qualification:** a green check applies only to the exact commit SHA that the workflow tested.

## Current Drive work

Owner-controlled Drive backup, account verification before upload/restore, Android authorization compatibility, Gate 3 candidate SHA handling and documentation are consolidated in PR #55. The PR is not merged. See [Backup Architecture](BACKUP-ARCHITECTURE.md) and the [PR](https://github.com/Akshayshetye37/Aurelia-apk/pull/55).
