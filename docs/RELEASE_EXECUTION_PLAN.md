# Aurelia release execution plan — R1 first

**Binding acceptance standard:** Every packet must satisfy [`docs/DEFINITION_OF_DONE.md`](DEFINITION_OF_DONE.md). The repository PR template carries the universal checklist. Any unchecked item means the packet remains In progress/Blocked; do not begin the next packet until the current packet is accepted, merged, and green.

**Decision:** Replace parallel multi-workstream delivery with three sequential releases. R1 is a local-only PMS. No external money movement or cloud sync is part of R1.

**Baseline audited:** `feature/multi-provider-payment-backend` at `410175355120c62a3b16a716169fdcf86ef7b6f9` (2026-11-09). This is a source/documentation baseline, not a release candidate.

## 1. Release boundaries

### R1 — Local-only PMS
Included:
- Canonical local persistence, migrated incrementally by domain.
- A single append-only financial journal and deterministic read projections.
- Manual cash and staff-confirmed payment workflows only.
- Offline PIN, lockout and recovery-key controls.
- Android SQLite qualification and backup/restore qualification.
- Auditable migration, rollback and operational recovery.

Explicitly excluded and required to remain OFF:
- Live gateway collection, automatic settlement and automatic refund posting.
- Pay Bridge dispatch/authorization.
- Cloud sync, remote write transport and multi-device conflict resolution.
- Global `uiCutover` or any unqualified domain cutover.
- Production release signing/publishing until release approval.

R1 acceptance: local operational workflows pass domain, ledger, recovery, security and supported-device gates on the exact candidate SHA. A passing web test suite or APK compile alone is insufficient.

### R2 — One payment provider
Choose one provider only after R1 ledger sign-off and confirmation of actual hotel merchant usage. Razorpay is a candidate, not a pre-approval. All other provider adapters remain disabled.

Required lifecycle: server-owned idempotent intent; immutable binding to tenant/property/booking/folio/device/merchant/amount/currency/environment; durable webhook inbox; signature and authoritative provider-status verification; timeout/UNKNOWN reconciliation; one-time device authorization; local journal posting; read-back and acknowledgement; refund/reversal lifecycle. Complete real sandbox payment and refund tests before any enablement. If the Pay Bridge companion source is not controlled and qualified, it is excluded rather than emulated.

### R3 — Optional sync
Only after R1 has operated with real local data and the operational model is validated. Add device enrollment, authenticated transport, bootstrap, durable inbox/outbox processing, conflict workflows, retention and restore drills. Pay Bridge and additional providers are separate post-R3 candidates, not hidden dependencies.

## 2. R1 execution sequence

### Gate R1-A — Governance and baseline
- Use `release/r1-local-first-execution` as the execution branch; do not change the existing feature branch or merge automatically.
- Generate a per-run `STATUS.md` artifact from actual workflow outcomes, including the exact candidate SHA and run URL. The checked-in `STATUS.md` is only a pointer to that generated artifact; do not hand-edit gate pass/fail claims or carry evidence forward to a different SHA.
- Require protected-branch review and required checks before merge. Verify settings after applying them; do not claim protection from configuration intent alone.
- Keep secrets out of source, logs, issues and chat. Signing keys remain under owner control.
- Correct workflow path filters so native template changes trigger the relevant CI job.
- Keep this branch as a reviewable PR candidate; no release or deployment is implied.

### Gate R1-B — Domain migration and shadow observation
Migration order: **settings → rooms → guests → bookings → folios/payments → inventory → expenses → restaurant**.

For each domain:
1. Define stable identity, schema/version, ownership, validation and foreign-key rules.
2. Add a domain-specific authority flag with default OFF. A flag may only select a domain after its gate passes; flags must not be a backdoor for global cutover.
3. In shadow mode, read canonical data independently, compare normalized values to legacy, and emit privacy-safe mismatch diagnostics. Legacy remains the displayed/authoritative result until promotion.
4. Never log guest names, contact details, payment references, tokens or raw financial payloads. Diagnostics use opaque record IDs, field paths, counts and reason codes.
5. Require representative real-data coverage, zero unexplained mismatches, migration replay/read-back tests, restart/process-death tests, and a successful rollback drill. Two weeks is a minimum observation window, not automatic approval.
6. Promote one domain at a time. Preserve the legacy snapshot and rollback path for at least one subsequent release. Remove legacy writes only after promotion and rollback acceptance.

Rooms precede guests/bookings because stable room identities and foreign keys are dependencies. Booking/folio promotion is blocked until accounting reconciliation is signed off.

### Gate R1-C — Financial diagnostic and immutable journal
First implement a **read-only** diagnostic. It must report, without modifying data:
- Duplicate candidate payment records and duplicate stable references.
- Orphan payments and payments without a resolvable booking/folio.
- Negative, overpaid and inconsistent balances.
- Differences among legacy `p`, `pays[]`, `payments[]`, folio totals, receipts and daily totals.
- Currency/precision anomalies, invalid timestamps and records with ambiguous identity.
- Totals and counts by reason code, with no personal data in logs.

Run against fixtures first, then an owner-authorized redacted production backup. Do not claim real-data validation until that backup is supplied and reviewed.

Journal rules:
- Append-only entries; no update/delete API for posted financial entries.
- Store integer minor units and explicit ISO currency; reject unsupported precision and currency.
- One stable payment identity per actual payment. Amount, timestamp and reference are candidate matching signals, never sufficient grounds for silent deletion.
- Ambiguous duplicates go to human review. Preserve original source snapshots and provenance.
- Corrections are compensating/reversal entries, never edits to history.
- Folio balance, receipts and daily totals are reproducible projections, not competing authorities.
- A payment command, journal entry, folio effect, audit event and outbox event commit in one local database transaction. Any failure rolls all of them back.
- Enforce idempotency and concurrency control at the repository transaction boundary.

No historical migration or repair runs automatically. Accounting owner approval is required for the mapping and any ambiguity disposition.

### Gate R1-D — Android persistence and recovery qualification
Automated emulator/CI suite:
- Shared repository contract vectors across IndexedDB and SQLite where platform capabilities permit.
- SQLite-full error mapping; serialization failure rollback; migration and schema-upgrade rollback.
- Process death at each durable checkpoint; restart/read-back consistency.
- Backup, clean-profile restore and checksum equivalence.
- Atomic entity + journal + audit + outbox transaction invariants.

Physical-device matrix: at least two supported devices, including one lower-end device. Test low storage, force-stop, process death, reboot, upgrade, backup/restore, PIN lockout and recovery-key restore. Record device model, OS/build, app SHA, test case, result and evidence in `QUALIFICATION.md`. Emulator results do not substitute for hardware Keystore/biometric acceptance.

R1 security scope: PIN, bounded lockout, secure recovery key, key lifecycle, local data protection and recovery. SMS alone must never reset or regenerate a data-encryption key. Signed-envelope and clock-tamper qualification belongs to R2 unless required by an R1 local trust boundary.

## 3. R2 payment gate

- Server owns intent state and transition validation.
- Provider dispatch identity is persisted before external I/O.
- A timeout after dispatch becomes UNKNOWN; retry performs read-only lookup with the same identity, never a fresh charge.
- Verify webhook raw bytes/signature and provider status server-side; dedupe by provider + environment + merchant + event ID and reject event-ID/payload conflicts.
- Bind merchant, tenant, property, booking, folio, device, amount, currency and environment.
- Test forged, duplicate, delayed, out-of-order, replayed and mismatched events, concurrent requests, lost acknowledgements, refunds and reversals.
- Sandbox payment and refund evidence plus provider-owner sign-off are mandatory.
- No production collection until explicit owner authorization and a separately approved release candidate.

## 4. Security and operational invariants

- Fail closed on unknown status, missing identity, version conflict, failed read-back or unavailable journal.
- Never trust WebView redirects, client callbacks, notification text or provider-echoed amount as payment proof.
- Never put credentials, webhook secrets, guest PII or raw financial records in client logs.
- Keep external network I/O outside local database transactions.
- Enforce tenant/property authorization at the trusted service boundary in R2; R1 remains local and does not imply multi-user cloud authorization.
- Keep feature flags default-OFF and test the OFF state in CI.
- Do not delete migration source data in the same release that promotes a domain.
- A passing test is evidence only for the exact commit and tested environment.

## 5. Immediate work order

1. Establish this execution branch and this release plan/status ledger.
2. Correct native template workflow path filters and add template-change regression coverage.
3. Add a privacy-safe read-only financial diagnostic and fixture suite; do not migrate or repair historical data.
4. Add domain shadow-mode primitives with default-OFF authority and mismatch-safe legacy display.
5. Migrate settings and rooms first; defer guests/bookings until stable ID constraints are proven.
6. Add emulator instrumentation and qualification records; physical tests remain pending until performed.
7. Configure and verify branch protection and required checks.

## 6. Exit criteria and blockers

R1 cannot be called production-ready while any of these remain open: unresolved financial diagnostic discrepancies; no authorized redacted backup review; incomplete domain read/write cutover; untested rollback; missing native SQLite instrumentation; missing physical-device/key recovery evidence; missing accounting/security/owner sign-off; or a release candidate not verified on its exact SHA.

External constraints are recorded as blockers, not simulated: real backup availability, physical devices, merchant sandbox accounts, companion-app source control, repository-admin settings and owner signing credentials.

**Current decision:** NOT PRODUCTION READY. R1 implementation is in progress. Gateway, Pay Bridge, sync and production release remain disabled.
