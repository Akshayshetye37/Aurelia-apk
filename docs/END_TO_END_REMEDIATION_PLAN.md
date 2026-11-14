# Aurelia PMS — 10-workstream end-to-end remediation and release plan

> **SUPERSEDED for execution order and status (2026-11-14).** Use [REMAINING_WORK_AUDIT_2026-11-09.md](./REMAINING_WORK_AUDIT_2026-11-09.md) as the sole canonical plan. This document is retained only as historical/technical reference; do not use its phase ordering or status snapshot to authorize work or release.

**Status:** Engineering execution specification; implementation and acceptance are not complete.  
**Branch:** `feature/multi-provider-payment-backend`  
**Release policy:** Do not run debug APK, release APK, signing, publishing or production deployment workflows until all ten workstreams have passed their acceptance criteria. CI source tests may be run only when they do not invoke an Android/APK build; no build workflow is an acceptable substitute for end-to-end acceptance.  
**Current architecture decision:** Preserve the existing offline-first PMS booking/folio ledger. The cloud service is the payment authority; a separately trusted native bridge is the only permitted path for verified cloud payment evidence to reach the local PMS accounting mutation boundary. Do not treat the prototype Firestore `paymentFolios` model as the canonical PMS ledger.

## Executive decision

The current repository is a partially implemented payment foundation, not a completed payment product. The work must proceed in dependency order. No later stage can compensate for a missing earlier stage. A provider is not operational merely because it has an adapter class, a credential form, a checkout URL, a webhook route or a passing unit test.

The release-critical transaction is:

```text
Reservation / booking
  → canonical PMS folio and amount due
  → authenticated, idempotent payment intent
  → provider order and checkout
  → provider-verified capture
  → durable event inbox and reconciliation
  → short-lived one-time device authorization
  → trusted Pay Bridge IPC
  → canonical local PMS settlement
  → durable read-back and device acknowledgement
  → backend posted state
  → receipt and immutable audit trail
```

Refunds are a separate lifecycle:

```text
Refund request
  → idempotent provider refund
  → provider-verified refund status
  → durable refund event
  → trusted local accounting reversal/adjustment
  → read-back and acknowledgement
  → receipt / audit update
```

A successful provider capture is not a posted PMS payment. A successful local write without backend acknowledgement is an ambiguous distributed outcome that must be recovered, not repeated.

## Non-negotiable engineering invariants

1. Never claim production readiness from source inspection or CI alone.
2. Never infer canonical folio schema from the separate cloud prototype.
3. Never auto-repair historical financial balances.
4. Never let WebView JavaScript, redirects, SDK callbacks, screenshots or booleans authorize a financial posting.
5. Never redispatch an ambiguous provider order or refund with a new identity.
6. Never mark a journal row posted based only on a status update; posting requires the real settlement mutation and durable read-back.
7. Every money value is an integer in minor units at service boundaries; currency is explicit and validated.
8. Every mutation is tenant-, property-, booking-, folio-, device- and identity-bound as applicable.
9. Keep provider credentials and webhook secrets exclusively in managed backend secret storage.
10. Fail closed on timeout, mismatch, unavailable authorization, unavailable ledger, unknown provider result or failed read-back.
11. Keep local PMS operational offline for non-gateway hotel operations. Do not promise offline gateway capture.
12. No live collection, automatic settlement, refund posting or release build before all ten gates and owner approval pass.

## Workstream 1 — Booking, folio and financial source-of-truth

**Problem to resolve:** The current PMS uses local booking objects in `S.b[]`; inspected fields include `booking.p`, `booking.pays[]`, `booking.payments[]` and `state.today`. Due calculations and invoice/payment helpers do not consistently derive paid value from the same representation. The cloud `paymentFolios` prototype is not proven to be the PMS ledger.

**Implementation**
- Trace every booking create/edit/cancel/checkout/import/restore and every payment, invoice, due and daily-takings read/write path.
- Define a versioned canonical folio contract and a deterministic mapping from booking ID to folio ID, tenant/property and currency.
- Define one canonical payment journal representation. Treat legacy mirrors as compatibility projections, not competing sources of truth.
- Add a read-only diagnostic that reports mismatches, duplicate references, negative/overpaid balances, orphan payments and aggregate drift.
- Run diagnostics on an authorized, redacted real backup and representative restore/import fixtures.
- Write a reviewed migration/reconciliation procedure with before/after snapshots, reversible operations and per-record audit. Do not execute a repair automatically.

**Acceptance evidence**
- Signed-off schema/data dictionary and migration policy.
- Diagnostic output reviewed by the accounting owner.
- Tests prove due, invoice, receipt, daily takings and booking views agree for new, legacy, imported, cancelled and restored bookings.
- Concurrency and duplicate-post tests prove balances cannot be over-credited.

**Stop condition:** Any unexplained historic discrepancy, ambiguous booking identity or lack of authorized backup blocks all settlement work and release.

## Workstream 2 — Payment intent, binding and idempotency

**Implementation**
- Define a server-authoritative intent state machine, including created, order-created, awaiting-provider, captured-unposted, authorization-issued, device-posted, posted, unknown/reconciliation-required, failed, partially-refunded and refunded states.
- Bind each intent to tenant, property, booking, canonical folio, device, amount minor units, ISO currency, provider, environment, merchant account, stable idempotency key and deterministic provider reference.
- Compute a canonical request fingerprint over every material field; reuse of a key with changed details must conflict.
- Make reservation and provider dispatch concurrency-safe. Persist dispatch intent before external I/O.
- Treat network timeout or process death after dispatch as UNKNOWN. Recover by read-only lookup using the same provider identity; never create a second order until the first is conclusively resolved.
- Enforce due amount and overpayment policy from the authoritative folio, not a client-supplied amount.

**Acceptance evidence**
- Concurrent duplicate request tests; changed-payload conflict tests; tenant/device/folio binding tests.
- Crash injection before and after provider dispatch.
- Recovery tests show one provider order maximum for one intent and preserve folio locks while outcome is unknown.

**Stop condition:** Any path that can create a second charge/order from a retry blocks release.

## Workstream 3 — Provider adapters, checkout, capture and webhook verification

**Implementation**
- Complete Razorpay and Cashfree as the first reference integrations, using their official current merchant API contracts and exact configured product versions.
- Define a shared Aurelia adapter interface, but keep provider signing, request formats, status semantics, webhook parsing and refund behavior provider-specific.
- Verify raw webhook bytes with environment-specific secrets and constant-time signature comparison.
- Persist a durable inbox keyed by provider, environment, merchant account and provider event identity. Detect event-ID/payload conflicts and replay.
- Treat webhook and polling as signals to run the same authoritative provider status verification path.
- Match provider order ID, payment ID, merchant account, amount, currency, environment, tenant and intent before declaring capture.
- Keep PayU, PhonePe, Paytm, JioPay and CCAvenue disabled until each is independently implemented, contract-tested, sandbox/UAT-certified and passes its own release gate. No generic adapter or catalogue entry counts as support.

**Acceptance evidence**
- Official API contract references pinned to provider product/version.
- Adapter contract suite for create, lookup, status, capture, webhook, duplicate/replay, timeout and malformed responses.
- Merchant sandbox/UAT transaction evidence for each enabled provider/environment.
- Negative tests for forged signatures, stale timestamps, mismatched amounts/currency/order/merchant and unknown events.

**Stop condition:** An adapter missing any required operation remains excluded from the production registry and UI.

## Workstream 4 — Durable reconciliation and distributed recovery

**Implementation**
- Implement durable inbox/outbox records and atomic worker claims with lease owner, lease expiry, bounded batch size, attempt count, exponential backoff and dead-letter handling.
- Use compare-and-set / Firestore transactions to prevent concurrent workers from claiming the same event.
- Reconcile provider order creation, capture, device settlement, acknowledgement loss, refund creation and refund completion.
- Model local commit + lost acknowledgement as a recoverable state. On retry, query local journal/read-back by immutable command identity before deciding whether to replay.
- Define retention, replay, manual review and operator escalation policies. Never discard UNKNOWN records.
- Add metrics and alerts for aged UNKNOWN, failed webhooks, expired leases, repeated provider failures and capture-not-posted.

**Acceptance evidence**
- Worker race tests with parallel workers and lease expiry.
- Process-kill/network-partition tests at each distributed boundary.
- Replay/recovery drills demonstrate convergence without duplicate financial entries.
- Operational dashboards, alerts and dead-letter runbook.

**Stop condition:** Any non-durable in-flight state or unbounded/duplicate worker claim blocks release.

## Workstream 5 — Trusted Pay Bridge application and IPC

**Implementation**
- Obtain and inspect the separate Android source repository for package `com.aurelia.paybridge`. It was not present in `Akshayshetye37/Aurelia-apk` at the inspected checkpoint.
- Implement the companion service, manifest permission, package identity, signer checks, protocol negotiation and versioned payment/refund/status messages in the companion application—not as constants-only PMS templates.
- Bind every IPC command and response to correlation ID, immutable intent/command ID, booking, folio, amount minor units, currency, provider, merchant reference, device identity and expiry.
- Validate Binder caller UID/package and signer on every privileged operation, not just initial handshake.
- Require one-time nonces and replay protection; make disconnect, process death, timeout, package replacement and signer mismatch fail closed.
- Do not embed merchant API secrets or webhook secrets in either APK. Provider SDK use, if required by the chosen merchant product, belongs only in the companion app and must not bypass backend verification.

**Acceptance evidence**
- Source review of both APKs and matching protocol contract tests.
- Both release APKs signed with the owner-controlled signing identity; signer fingerprints match.
- Physical-device tests for install/upgrade, binding, reconnect, process death, stale/replayed messages, wrong signer, wrong caller, and app lifecycle.
- Capability advertised only after the exact operation is implemented and tested.

**Stop condition:** Without the companion source repository and a working two-app device test, no payment execution or release build is allowed.

## Workstream 6 — Canonical local settlement, journal and receipts

**Implementation**
- Preserve the existing `settlePayment()` mutation boundary only after Workstream 1 establishes its canonical invariants. Do not route gateway events into the separate Firestore folio prototype.
- Implement a trusted native authorization issuer/verifier. Authorization must be short-lived, one-time, signed or otherwise cryptographically authenticated, and bound to intent, provider transaction, tenant, booking, folio, amount, currency, device, expiry and nonce.
- Have the native bridge invoke a narrow native-to-PMS settlement command. Arbitrary WebView flags and public JavaScript callbacks cannot mint or validate authorization.
- Make local posting idempotent on immutable provider transaction/command identity. Atomically persist the payment row, canonical paid total, compatibility projection and audit record, or use a recoverable journal with a rigorously tested projector.
- Read back the persisted ledger and verify the exact payment identity and amount before acknowledging the backend.
- Generate receipts only from the durable canonical payment record; preserve receipt identity across retries.
- Keep the global accounting kill switch closed until the real-data audit and all settlement acceptance evidence pass. Do not simply flip the current boolean or add a public POSTED status setter.

**Acceptance evidence**
- Unit, integration and fault-injection tests prove exactly-once financial effect under duplicate command, process death, storage failure and acknowledgement loss.
- Local ledger read-back matches booking due, invoice, receipt and daily totals.
- Receipt can be regenerated deterministically from the posted record and includes provider/reference/audit identity.

**Stop condition:** No trusted issuer, no durable canonical write/read-back, or any ledger divergence blocks settlement and release.

## Workstream 7 — Refunds and accounting reversals

**Implementation**
- Define full and partial refund domain models with stable refund ID, original intent/payment identity, requested amount, cumulative refunded amount, currency, reason, actor and audit history.
- Enforce cumulative refunds cannot exceed captured less already-refunded value, using a transaction/lock at the authoritative payment record.
- Use stable idempotency keys and deterministic provider refund references. Ambiguous refund submission is UNKNOWN and must be looked up before retry.
- Verify refund status directly with the provider and validate payment identity, amount, currency and terminal status.
- Post a separate local debit/adjustment journal event; never mutate or delete the original payment credit.
- Reconcile refund status, local reversal and backend acknowledgement independently. Support partial refund and multiple refund attempts safely.

**Acceptance evidence**
- Full/partial refund tests, duplicate/replay tests, amount cap/concurrency tests, timeout/recovery tests and provider sandbox refund evidence.
- Ledger and receipt show original capture and refund as separate traceable entries.

**Stop condition:** A provider refund method alone is not refund support; no accounting reversal/read-back means refund capability stays disabled.

## Workstream 8 — Authenticated Android API, sessions and operational UX

**Implementation**
- Wire the payment API client to the actual Firebase authentication lifecycle and trusted native identity/session provider.
- Enforce tenant/property role authorization server-side on every intent, status, refund, reconciliation and owner configuration operation.
- Implement token expiry/refresh, revocation, MFA freshness, secure transport, request correlation, bounded retry and redacted error handling.
- Expose provider choices only from backend capability/qualification responses; do not infer availability from hard-coded provider labels.
- Provide staff UX for pending, unknown, capture verified but not posted, posted, failed, refund pending and reconciliation required. Prevent staff from creating a duplicate payment while the prior outcome is unknown.
- Keep non-payment PMS workflows usable offline. Queue only explicitly safe local actions; never queue a gateway charge to be silently executed later without a new authorized user action.
- Store no merchant secret in WebView/local storage, preferences, app assets, backups or logs.

**Acceptance evidence**
- Auth/session integration tests for expired, revoked, wrong-tenant, wrong-role and stale-MFA tokens.
- Physical-device tests for offline, online, app background/foreground, process death, token refresh and user logout.
- UX tests prove UNKNOWN locks duplicate checkout and presents a recoverable operator path.

**Stop condition:** No real session binding or no capability-driven UI means gateway controls remain unavailable.

## Workstream 9 — Security, infrastructure, observability and operations

**Implementation**
- Provision production cloud infrastructure only after owner configuration/approval: workload identity, Firestore, Secret Manager, HTTPS ingress, DNS/TLS, webhook routes, IAM, backups and retention.
- Validate Firestore rules and IAM using emulator and deployed policy tests. Apply least privilege by service account and collection.
- Restrict backend network ingress to the trusted HTTPS proxy; configure forwarded headers safely and exact origin allowlists.
- Add structured redacted audit logs, trace/correlation IDs, metrics, alerts, rate limits, abuse controls and incident response procedures.
- Define key rotation, provider credential rotation, webhook secret rotation, signing-key custody, backup restore, disaster recovery and data retention.
- Run dependency, SAST, secret scanning, mobile security and API threat-model reviews.
- Keep test and live merchant accounts, secrets, webhook endpoints and data isolated.

**Acceptance evidence**
- Infrastructure deployment record and configuration review.
- IAM/Firestore rules tests, external security review, secret scan and mobile/API penetration test closure.
- Successful backup restore and incident/revocation drill.
- Monitoring and on-call runbooks with alert delivery verified.

**Stop condition:** No production deployment or live merchant traffic until security and operational evidence is signed off.

## Workstream 10 — End-to-end qualification, release decision and build control

**Implementation**
- Build a test matrix across each enabled provider, environment, device and lifecycle state.
- Execute the complete booking-to-payment-to-ledger-to-receipt path using merchant sandbox accounts and physical Android devices.
- Execute full and partial refunds and verify the local accounting reversal.
- Inject duplicate requests, duplicate webhooks, forged callbacks, delayed/out-of-order events, provider 5xx/timeouts, process death, offline device, storage failure, expired authorization, lost acknowledgement, worker concurrency and restore.
- Verify financial invariants before and after every test: one capture creates at most one payment credit; one refund creates at most one reversal; balances and receipts reconcile exactly.
- Capture evidence: commit SHA, test reports, provider request/reference IDs (redacted), webhook evidence, ledger before/after snapshots, device logs (redacted), security approval and owner sign-off.
- Only after every prior workstream is accepted may a release candidate be built. Release signing, publishing and live controls require separate explicit authorization.

**Acceptance evidence**
- All required automated suites pass without skipped critical tests.
- End-to-end test report demonstrates payment capture, local post, receipt, refund, local reversal and recovery on physical device.
- Accounting owner, security reviewer and product owner sign the release checklist.
- Release candidate is built from the exact approved commit and verified artifact digest.

**Stop condition:** Any critical test failure, unresolved discrepancy, unverified provider or missing approval blocks build and release.

## Delivery order and dependencies

| Order | Workstream | Depends on | Release gate |
|---:|---|---|---|
| 1 | Booking, folio and financial source-of-truth | Real schema + authorized backup | Canonical accounting contract approved |
| 2 | Intent, binding and idempotency | 1 | No duplicate/ambiguous dispatch |
| 3 | Provider checkout, capture and webhook | 2 | Provider UAT and verification pass |
| 4 | Durable reconciliation and recovery | 2, 3 | Crash/replay convergence pass |
| 5 | Trusted Pay Bridge and IPC | Separate bridge source; 2–4 contracts | Physical two-app trust tests pass |
| 6 | Canonical local settlement and receipts | 1, 4, 5 | Exactly-once local post/read-back pass |
| 7 | Refunds and accounting reversals | 1–6 | Provider refund + local reversal pass |
| 8 | Authenticated Android API and UX | 2–7 | Session/device lifecycle pass |
| 9 | Security and operations | 1–8 | Production controls independently approved |
| 10 | End-to-end qualification and build control | 1–9 | All evidence signed off |

## Current blockers that cannot be solved by guessing

- **Pay Bridge source:** No repository URL or source for `com.aurelia.paybridge` has been provided or found in the Aurelia PMS repository. Its actual service implementation cannot safely be authored as if it already existed.
- **Canonical production data:** The real PMS backup and accounting-owner decision on legacy discrepancies are not present in this repository.
- **Merchant/provider evidence:** Credentials, merchant product enablement and sandbox/UAT acceptance must come from the account owner/provider; do not fabricate them.
- **Production environment:** Firebase project, workload identity, Secret Manager, trusted ingress, domains and operational ownership require explicit owner configuration.
- **Physical-device evidence:** A CI-generated APK is not evidence of installed two-app operation, provider checkout, settlement durability or receipt correctness.

## Build and release prohibition

Until all ten workstreams pass, do not invoke workflows that generate debug APKs, signed APKs, app bundles, release artifacts, publish packages or deploy production infrastructure. Do not call a workflow merely to see whether it passes if that workflow builds an APK. Source-only checks and non-build tests may be run when they do not trigger build or deployment jobs.

The current payment safety locks remain closed. Do not change `blockAllBalanceMutations`, `automaticSettlement`, `liveCollection` or `nativeSettlementBridge` as a shortcut. The manual-payment behavior must be restored only through an accounting-owner-approved, narrowly scoped policy after Workstream 1—not by disabling the safety interlock indiscriminately.

**Definition of done:** The exact approved commit demonstrates the complete booking → intent → provider checkout → verified capture → trusted device authorization → canonical local settlement → durable read-back → backend acknowledgement → receipt flow, plus full/partial refund and reversal, with recovery under injected failures and signed acceptance evidence. Until then, Aurelia is not production-ready and no APK release build is permitted.
