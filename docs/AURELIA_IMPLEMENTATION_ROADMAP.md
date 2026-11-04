# Aurelia implementation roadmap

**Working branch:** `fix/phase-1-accounting-audit`  
**Release posture:** READ-ONLY / FAIL-CLOSED. This roadmap does not authorize financial posting, collection, refunds, deployment or merge.

## Operating rules

1. Work in one phase at a time. Do not start a later phase until its predecessor's evidence and acceptance criteria are reviewed.
2. Write or update failing tests before changing production logic.
3. Do not alter real PMS data. Diagnostics must be read-only; all migrations require a separate approved dry-run, backup, reconciliation and rollback plan.
4. Never add live provider credentials to source, APK, HTML, JavaScript, logs or committed environment files. Sandbox credentials are human-supplied through an approved secret store.
5. Keep all seven payment controls locked. No generic feature flag, local setting, WebView value, LAN command or stale device cache may bypass the server and native safety gates.
6. Treat successful CI as necessary but not sufficient. Emulator tests, sandbox provider verification, physical-device tests, security review and owner sign-off are separate release gates.
7. Record every assumption, evidence gap, test result and human-only action. Never mark a human-only requirement complete.

## Phase sequence and gates

| Phase | Scope | Exit evidence |
|---|---|---|
| 1. Accounting truth and data diagnosis | Complete read/write path inventory; read-only backup diagnostic; duplicate payment, malformed amount, orphan advance and refund-overpayment checks; inspect a real authorized backup. | Tests pass; report includes real record counts and sampled evidence; no automatic repair; owner approves the accounting source-of-truth decision. |
| 2. Canonical ledger contract | Define booking, folio, payment, refund, adjustment and journal schemas; resolve paise precision, IDs, currency, migration/versioning and legacy compatibility. | Written invariants, schema tests, migration dry-run against a copy, rollback proof and explicit approval. |
| 3. Signed cloud-to-device policy | Device identity and enrollment; signed short-lived tenant/device-bound policy lease; expiry, nonce/version, key ID, revocation and replay protection; safe clock-skew handling. | Signature, tamper, wrong-tenant/device, expiry, replay, key rotation and cloud-unavailable tests pass. No local UI flag can grant permission. |
| 4. Trusted settlement and recovery | Bind provider-verified intent to booking/folio/device; native verification; durable idempotent command journal; atomic local projection or explicit pending reconciliation; recovery after crash/offline. | Failure-injection and duplicate/reorder tests prove exactly-once accounting effect; unresolved outcomes remain pending, never guessed. |
| 5. Payment state machine and reliability | Formal states/transitions; webhook dedupe; out-of-order events; timeouts; provider ambiguity; retry/backoff; observability and operator recovery. | State-transition contract tests and concurrency/failure tests pass; no terminal-state regression or duplicate posting. |
| 6. Refund and reconciliation | Separate refund request, provider acceptance, settlement, failure and reversal; reconcile provider statements against canonical folio journal. | Provider evidence required for paid status; balanced journal invariants; unresolved differences are visible and cannot be auto-written. |
| 7. Provider qualification | Complete Razorpay/Cashfree sandbox and certification; then implement/qualify PayU, PhonePe, Paytm, JioPay and CCAvenue behind one adapter contract. | Per-provider sandbox evidence, signature tests, idempotency, refund, webhook and failure tests; credentials held only in secret manager. |
| 8. Owner control panel | Owner-only controls, approvals, device inventory, audit search, emergency stop and health state. | Auth/MFA/tenant isolation tests; every action server-authorized and durably audited; UI is never the authority. |
| 9. Security and infrastructure hardening | Merge Firestore rules with full existing rules; emulator tests; IAM least privilege; key rotation; threat model; rate limits; logging redaction; backup/restore. | Independent security review and emulator/integration evidence; no broad client write access. |
| 10. Android acceptance and release | Capacitor/native bridge lifecycle; storage durability; multi-device conflicts; upgrade/restore; physical-device network and crash testing; operational runbooks. | Signed build, device matrix, recovery drill, human security review, owner release sign-off and explicit deployment authorization. |

## Phase 1 implementation notes

- Current diagnostic is read-only and compares `booking.p` with `booking.pays[]`.
- Additional diagnostic checks are being added for duplicate idempotency keys/references, reservation-advance identity mismatches, malformed refund values and refunds exceeding recorded paid amounts.
- `booking.payments[]` is treated as a compatibility/history mirror and is not added to the canonical sum. Its relationship to `pays[]` must be validated from actual exports.
- No source-of-truth decision is made from demo fixtures or code shape alone.
- The CLI reads a supplied backup and emits JSON to stdout. It does not modify the input file.
- The real backup and owner review are human dependencies. Until supplied, Phase 1 cannot pass its data-evidence gate.

## Stop conditions

Stop the current phase and report instead of guessing if:
- source data shape differs from the assumed schema;
- a duplicate could be a legitimate mirrored event;
- a payment's provider outcome is ambiguous;
- device identity, signing key or tenant mapping is not verifiable;
- a test requires live credentials or real customer money;
- a migration would mutate production data;
- any required human evidence or approval is missing.

## Current status

Phase 1 is IN PROGRESS. The code-level diagnostic and initial source inventory are not a substitute for a real backup analysis or complete repository-wide mutation audit. Phases 2–10 are planned, not complete.
