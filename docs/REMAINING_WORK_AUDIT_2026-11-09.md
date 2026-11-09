# Aurelia — remaining work and end-to-end implementation plan

**Audit branch:** `feature/multi-provider-payment-backend`  
**Audited commit:** `1431611075c8bebddda445facecd01367a610892`  
**Audit date:** 2026-11-09  
**Purpose:** Record only the work that remains to make the local-first PMS dependable and to complete optional online payment capabilities. This document supersedes earlier remaining-work lists where their status or wording conflicts with this audit.

## 1. Product contract that every implementation must preserve

- The primary device is the operational source of truth for PMS data.
- Android uses native SQLite. Browser/PWA uses IndexedDB.
- Ordinary PMS operations must work without internet, Firebase, a cloud account or a remote server.
- Internet is used only when available for explicitly online features. Losing connectivity must not disable local PMS operations.
- Cloud hosting and sync are optional. Sync is not a prerequisite for launch or for local data correctness.
- Online gateway order creation, provider verification, refunds and reconciliation require connectivity. An offline action must never pretend that a gateway payment occurred or silently dispatch a charge later.
- A local write is successful only after the device database transaction commits and the committed data is read back and verified.
- RAM and Web Storage compatibility caches are never durable business-data authorities.
- Cash/manual payment recording and staff-reviewed evidence remain local workflows and must not depend on the online payment backend.

## 2. Remaining work — dependency order

### Workstream A — Finish the primary-device database cutover

**Current blocker:** The repository and both storage adapters exist, and several important workflows already commit locally. The global UI cutover is still `uiCutover=false`. The bootstrap coordinator deliberately prepares canonical storage without switching the entire synchronous UI to it. `index.html` still owns a large in-memory state object and uses the legacy `aurelia_lodge_v2` Web Storage snapshot as a compatibility/recovery cache. The source still reads that cache during import/restore and startup paths.

**Fix and implementation:**

1. Migrate all business reads and writes from the legacy state object to asynchronous domain/repository services. Do this in bounded domains, not as a rewrite:
   - Reservations and booking lifecycle, including every reservation creation/edit/advance/cancel path.
   - Guests, stable guest IDs and guest-to-booking foreign keys.
   - Rooms, stable room IDs, room reassignment and historical rate snapshots.
   - Folios, charges, payments, invoices, receipts and daily totals.
   - Inventory reads, edits, retirement, stock movements and POS-linked stock decrement.
   - Expenses, voids and reports.
   - Restaurant tables, orders, sales and every folio-charge path.
   - Settings, feature flags, audit history and auxiliary collections.
2. Hydrate each screen from canonical repository reads at startup and after mutations. Do not let a stale in-memory object overwrite newer repository state.
3. Convert each mutation to a version-checked repository transaction. Related entity changes and the corresponding immutable outbox event must commit in the same SQLite/IndexedDB transaction.
4. Add a persisted canonical-authority state machine. After the repository is authoritative, legacy restore/refresh/re-read paths must reject attempts to replace or overwrite canonical state. Recovery must be an explicit, validated operation.
5. Keep the legacy snapshot only as migration/rollback material until every domain has passed migration, read-back and recovery acceptance. Then remove it as a business-data read/write authority. Retain only explicitly approved preference storage.
6. Move photos/attachments to a durable device attachment store, include them in local backup/restore, and remove any session-memory fallback from the success path. A preview-only fallback must be visibly non-durable and must never report a durable save.
7. Add CI enforcement: reject the legacy business key and direct business-data Web Storage access outside the migration/compatibility boundary; restrict direct IndexedDB/SQLite/Web Storage access to storage modules; enforce a small preference-key allowlist.
8. Do not enable `uiCutover` until all domain read and write paths have been inventoried and migrated.

**Acceptance evidence:**
- Repository-backed read/write coverage for every domain listed above.
- No business-data persistence bypass remains in `index.html` or other UI modules.
- Stale-version, duplicate-command, transaction-rollback and restart tests pass for every domain.
- A repository-wide static check proves the storage boundary is enforced.
- A migrated data set survives app restart and reload with exact record counts and checksums.
- Canonical authority cannot be bypassed by import, restore, refresh, cache replay or startup recovery.

### Workstream B — Establish one correct local accounting model

**Current blocker:** The checked-in accounting audit identifies multiple representations: `booking.pays`, `booking.p`, `booking.payments` and daily totals. Some views derive paid amounts from payment rows while other balance calculations trust the stored paid total. Historic/imported rows can disagree. The local amount model is INR/paise-oriented and does not yet carry an explicit ISO currency per folio. The separate Firestore `paymentFolios` prototype has not been proven to be the live PMS ledger.

**Fix and implementation:**

1. Inspect an owner-authorized, redacted production-like backup and representative imports/restores. Do not infer or auto-correct historic balances.
2. Approve a versioned canonical booking/folio/payment schema with stable booking, folio, property and tenant identifiers; explicit ISO currency; integer minor-unit amounts; version/concurrency tokens; and a deterministic legacy mapping.
3. Choose one immutable payment journal as the financial source of truth. Treat old paid totals and payment-history arrays as compatibility projections only.
4. Reconcile every legacy booking before migration: payment rows, paid total, due, invoice, receipt, daily collection and cancelled/archived booking history. Quarantine unexplained discrepancies for owner review.
5. Implement append-only payment, charge, refund and reversal entries. Do not expose update/delete methods for posted financial journal entries.
6. Make folio balance a deterministic projection of valid journal entries. Use the same calculation in booking views, invoice, receipt, reports, exports and daily totals.
7. Add stable foreign keys for guest-to-booking and room-to-booking references. Preserve immutable historical room rates and payment references.
8. Commit booking/folio/journal/audit/outbox changes atomically on the local database. Use optimistic concurrency and deterministic idempotency keys.
9. Define migration and rollback policy for legacy records, including unresolved/duplicate payment references and imported data.

**Acceptance evidence:**
- Accounting owner signs the schema and legacy mapping.
- No unexplained discrepancies remain in the authorized diagnostic data set.
- New, imported, cancelled and restored booking fixtures produce identical paid, due, invoice, receipt and daily totals.
- Duplicate and concurrent postings cannot create a second credit.
- Journal entries are append-only and every receipt resolves to a durable journal entry.

### Workstream C — Qualify local persistence, backup and recovery on Android

**Current blocker:** Native SQLite and Capacitor repository templates exist, including transactional entity/outbox writes and migration snapshot storage. The shared adapter contract is not yet demonstrated against both engines as one suite, and physical-device acceptance is not evidenced. Native schema upgrade, process death, full-disk, corruption and recovery behavior still need qualification.

**Fix and implementation:**

1. Build one shared repository contract suite and run the same cases against IndexedDB and the actual Android SQLite plugin.
2. Persist and test migration authority, verified-migration markers, immutable legacy backup references, resumable checkpoints and schema version state in SQLite.
3. Verify transaction rollback, multi-entity atomicity, outbox leasing, WAL/checkpoint behavior, database close/reopen, process death and app restart.
4. Test schema upgrades from every supported released version. A failed upgrade must preserve recoverable prior data and must not start with an empty PMS.
5. Implement typed storage-full, permission, corruption and unavailable-database errors. Never fall back to RAM and report success for business records.
6. Complete local backup/restore for the canonical database and attachments. Validate format version, encryption, checksum, record counts, references and post-restore read-back.
7. Test clean install, upgrade, interrupted migration, backup → wipe → restore, rollback, low storage, app force-stop, device reboot and Android process recreation on supported physical devices.
8. Verify the packaged Android application uses native SQLite for business data and does not silently use WebView IndexedDB as a substitute.
9. Run instrumentation tests on representative Android versions and hardware, not only JavaScript mocks or static Kotlin source tests.

**Acceptance evidence:**
- The shared repository contract passes on IndexedDB and real Android SQLite.
- Physical-device restart, upgrade, process-death, rollback and backup/restore tests pass.
- Restored checksums, record counts and accounting invariants match the source.
- No business-data write succeeds through an in-memory fallback.

### Workstream D — Complete local device security and recovery

**Current blocker:** PIN enrollment/unlock, Android Keystore envelope protection and retry-state foundations exist. The native security document says biometric DEK wrapping is not integrated into the launch gate and forgotten-PIN recovery, phone registration, Firebase OTP recovery, recovery-key provisioning and backend recovery authorization are not implemented. Hardware-backed behavior is not qualified.

**Fix and implementation:**

1. Compile and instrument the native lock gate, crypto engine, envelope store, retry state and biometric path on supported devices.
2. Provision one random 256-bit DEK for the local dataset. PIN changes must re-wrap the same DEK; they must not replace it or orphan the encrypted database.
3. Complete the owner-controlled offline recovery-key flow. Store recovery material only in a user-selected secure location; test recovery without contacting a server.
4. Keep SMS OTP strictly as phone-control verification or recovery-workflow authorization. OTP alone must never unwrap, regenerate, replace or authorize a new DEK.
5. If no valid recovery key exists, make the data-loss consequence explicit and require deliberate confirmation before destructive reset.
6. Integrate biometric unlock only after authenticated Keystore cipher use succeeds and hardware/invalidation behavior is verified.
7. Test PIN throttling, tampered envelopes, wrong PIN, nonce uniqueness, process death, lock timeout, reboot, clock manipulation, biometric invalidation and backup/restore.
8. Ensure no PIN, PIN-derived key, plaintext DEK or biometric Keystore key reaches JavaScript, logs, analytics or the backend.

**Acceptance evidence:**
- Native instrumentation and physical-device tests pass.
- PIN rotation preserves access to the same encrypted data set.
- OTP-only requests cannot recover or replace the DEK.
- Recovery-key restore reproduces the original data; missing/invalid recovery material fails closed.

### Workstream E — Finish the optional online payment lifecycle

**Architecture boundary:** This workstream is optional to ordinary PMS operation. The app must remain useful when the payment backend is absent or unreachable. Gateway payments are online-only and must not be represented as offline transactions.

**Current blocker:** The backend has provider adapters, authenticated controls, intent state and webhook/status foundations. However, its settlement helper still targets the separate `paymentFolios/{tenant+folio hash}` and `journalEntries/{intentId}` model, which is not confirmed as the canonical local PMS ledger. Webhooks currently record verification evidence; they do not authorize local settlement or post the local folio. Reconciliation is a manual bounded sweep, not a scheduled/recoverable production worker. Live collection and automatic settlement are disabled.

**Fix and implementation:**

1. Finalize Workstream B's canonical local folio contract before mapping payment intents. Do not create a parallel authoritative ledger in Firestore.
2. Complete the backend intent state machine: created, order-created, awaiting-provider, captured-unposted, authorization-issued, device-posted, posted, unknown/reconciliation-required, failed, partially-refunded and refunded.
3. Bind each intent to tenant, property, booking, folio, device, provider, merchant account, environment, amount in integer minor units, ISO currency, stable idempotency key and immutable provider references.
4. Enforce payload fingerprints: reuse of an idempotency key with changed material fields must conflict.
5. Complete provider order creation, authoritative status lookup, raw-body/signature/checksum verification, durable webhook inbox, outbox, bounded worker claims, lease expiry, retry/backoff and dead-letter handling.
6. Reconcile ambiguous timeouts and unknown outcomes before retrying. Never create a replacement order or refund with a new identity while the previous outcome is unknown.
7. Wire the Android UI to the authenticated backend session and server capability response. Show pending, unknown, captured-but-not-posted, posted, failed, refund-pending and reconciliation-required states. Disable duplicate payment actions while an outcome is unknown.
8. Ensure loss of internet disables only the online gateway action. Local booking, folio viewing, manual payment recording, reports and other PMS operations continue.
9. Keep provider credentials, signing secrets and webhook secrets in Secret Manager only. Never put them in the APK, WebView, local preferences or backup.
10. Keep test/live environments separate and preserve the live-collection kill switch until every gate has independent evidence.

**Acceptance evidence:**
- Firestore emulator/integration tests prove tenant isolation, idempotency, worker lease recovery, webhook replay safety and durable state transitions.
- Provider capture is never treated as a local folio credit until the trusted device posting and read-back succeed.
- Offline mode leaves all local PMS operations working and does not queue a charge for later silent execution.
- A backend outage/restart recovers all in-flight intents without duplicate charge.

### Workstream F — Build the real Pay Bridge companion and trusted settlement path

**Current blocker:** The PMS repository contains only a Pay Bridge client/template and handshake contract. The companion application source is not present in this repository. The documented PMS-side integration currently supports connection/handshake only; it does not implement payment creation, refund, reconciliation or provider configuration IPC. The native settlement bridge kill switch is ON, and the settlement projector is not wired into a trusted end-to-end production path.

**Fix and implementation:**

1. Obtain and audit the separate Pay Bridge Android source repository, package identity, signing identity, manifest and provider SDK/licensing requirements.
2. Implement the companion service and versioned IPC protocol for payment, status, refund and recovery commands. Reserved message IDs are not functionality.
3. Enforce package and signer identity, signature-level permission, Binder caller UID/package checks, protocol negotiation, nonce/challenge, replay protection, request correlation IDs and bounded lifecycle/reconnect handling.
4. Bind every command to tenant, property, booking, folio, device, provider, merchant account, environment, amount, currency, transaction ID and expiry.
5. Implement the trusted backend issuer for short-lived, one-time settlement authorization and policy leases. Bind signatures to the complete immutable transaction identity.
6. Verify authorization in the trusted native boundary immediately before applying a settlement. WebView flags, redirects, screenshots and SDK callbacks must never mint authorization.
7. Make native settlement invoke one narrow local repository command. Atomically commit the immutable payment row, folio projection, audit record and receipt identity; read back exact values before acknowledging the backend.
8. Make journal recovery idempotent across app/process death and acknowledgement loss. Re-authorize pending entries; do not mark an entry posted from a status update alone.
9. Test both applications installed together, signed with the same owner-controlled signing certificate. Validate wrong signer, wrong caller, stale nonce, replay, changed amount, changed folio, expired lease, process death and reconnect on physical devices.

**Acceptance evidence:**
- Companion source repository is reviewed and its release artifact is reproducible.
- Both signed APKs pass package/signer/IPC tests on physical devices.
- One sandbox capture produces at most one local payment credit and one durable receipt.
- Backend acknowledgement occurs only after exact local database read-back.
- Lost acknowledgement and process restart recover without duplicate posting.

### Workstream G — Complete refunds and accounting reversals

**Current blocker:** Provider refund methods exist for six adapters, but CCAvenue lacks standard refund creation and authoritative refund-status support. A provider refund operation is not a complete PMS refund workflow. Local reversal posting, cumulative refund limits and end-to-end acknowledgement/recovery are not accepted.

**Fix and implementation:**

1. Create an immutable refund model linked to the original capture with refund ID, provider reference, amount, currency, reason, actor, idempotency key and state.
2. Enforce cumulative pending plus successful refunds never exceed the captured amount, under a transaction/lock.
3. Treat ambiguous refund dispatch as UNKNOWN and query provider status before retrying.
4. Confirm terminal refund success with the provider before posting a local reversal.
5. Commit refund journal, folio reversal, audit, receipt/history projection and outbox atomically on the local database.
6. Keep refund requested, processing, failed and completed as distinct states.
7. Complete CCAvenue standard refund and refund-status support only against a confirmed merchant-specific API contract. Otherwise leave that capability disabled.
8. Test partial refunds, multiple refunds, concurrent requests, duplicate webhook, timeout, process death and acknowledgement loss.

**Acceptance evidence:**
- Provider-confirmed refund maps to exactly one local reversal.
- Cumulative refund limits hold under concurrent requests.
- Receipts show capture and refunds as separate traceable entries.
- No refund capability is shown as available for an adapter without a complete accepted lifecycle.

### Workstream H — Provider merchant acceptance

**Current blocker:** Seven provider entries and mock adapter contract tests exist. Six adapters have seven-operation foundations; CCAvenue has a limited five-operation checkout/status/callback implementation. The evidence evaluator validates synthetic evidence but is not a persistent independent approval workflow. No merchant UAT is established by mock tests.

**Fix and implementation:**

1. Obtain merchant-issued sandbox credentials and confirm the exact merchant product/API version for each provider.
2. Deploy an isolated test-only HTTPS backend with test credentials, webhook ingress and redacted observability.
3. Run the documented common scenario suite for every provider: credential validation, checkout, success, failure, cancellation, pending recovery, forged callback rejection, webhook authentication, duplicate delivery, amount/currency mismatch, concurrency, timeout, refund, refund status and reconciliation.
4. Run provider-specific cryptographic tests: Razorpay raw-body signature; Cashfree timestamp/signature; PayU reverse hash; PhonePe authorization; Paytm checksum; JioPay HMAC; CCAvenue encrypted request/response and status API.
5. Persist evidence in a tenant-scoped acceptance register with unique run IDs, provider/environment, scenario, timestamp, transaction reference, build SHA, sanitized HTTPS evidence and independent reviewer identity.
6. Require independent reviewer and release-owner approval. Adapter existence or synthetic test evidence must not enable a provider.
7. Confirm CCAvenue merchant IP allowlisting and ordinary refund contract. Keep unsupported operations and providers disabled.

**Acceptance evidence:**
- Each enabled provider has a complete, recent, independently reviewed sandbox evidence bundle.
- Every enabled capability is backed by a real tested operation, not an adapter class or UI label.
- Live collection remains OFF until separate explicit production authorization.

### Workstream I — Optional cloud deployment, security and operations

**Current blocker:** Cloud Run, Firestore, Secret Manager and Terraform foundations exist. Actual production deployment, deployed rules/indexes, IAM, public webhook ingress, reconciliation scheduling, monitoring, disaster recovery and operational exercises are not evidenced. These services are not required to run local PMS operations; they are required only for the optional online payment service or any separately enabled remote feature.

**Fix and implementation:**

1. Deploy only the online payment service to a dedicated production project using workload identity and least-privilege IAM. Do not make PMS startup or ordinary operations depend on this deployment.
2. Deploy and emulator-test the complete Firestore rules and indexes. Verify tenant/property ownership, role checks, MFA recency, emergency stop and independent approval.
3. Configure public HTTPS ingress, TLS, trusted proxy headers, webhook reachability, request limits, provider allowlists where applicable and abuse/rate controls.
4. Schedule bounded reconciliation and recovery workers with lease ownership, retry/backoff, dead-letter handling and alerting.
5. Add redacted logs, metrics, dashboards and alerts for aged UNKNOWN intents, failed webhooks, expired leases, capture-not-posted, refund mismatch and emergency stop.
6. Establish secret rotation/revocation, backup retention, tested restore, incident response, outage and provider-dispute runbooks.
7. Perform dependency, secret, API, mobile and tenant-isolation security review; remediate findings before any live traffic.
8. Keep remote sync out of scope until separately requested. If added later, make it opt-in, conflict-aware, idempotent and incapable of blocking local operations.

**Acceptance evidence:**
- Deployed-like integration/security tests pass.
- Backup restore, key rotation, webhook outage and provider outage drills are signed off.
- Local PMS remains fully usable when the cloud payment service is stopped or unreachable.

### Workstream J — End-to-end qualification and release controls

**Current blocker:** The latest audited commit has a passing source/web workflow, not an APK build or physical-device qualification. The active branch is not protected and required status checks are not enforced. Historical test runs apply only to their recorded commit SHA.

**Fix and implementation:**

1. Add mandatory branch protection for reviewed changes and required source, backend and Android qualification checks appropriate to the change.
2. Run root PMS tests, payment-backend tests, syntax/type/lint/security checks, web production packaging and privacy checks on the exact candidate SHA.
3. Run Android generation, Kotlin/Java compilation, instrumentation and artifact checks after the implementation gates are ready. Then test signed release candidates on supported physical devices.
4. Execute an end-to-end matrix covering fresh install, upgrade, offline use, reconnect, local backup/restore, migration interruption, storage exhaustion, corruption, concurrent staff actions, duplicate payment, provider timeout, webhook replay, refund, process death and lost acknowledgement.
5. Verify financial invariants before/after every test: one capture creates at most one credit; one refund creates at most one reversal; folio, invoice, receipt and daily totals reconcile.
6. Record exact source SHA, test reports, artifact digest, provider evidence, redacted device logs and named accounting/security/product approvals.
7. Keep `uiCutover`, live collection, automatic settlement, automatic refund posting and release publishing disabled until their individual acceptance gates pass. Never bypass a gate to produce a demo APK.

**Acceptance evidence:**
- All required checks pass on the exact release candidate SHA.
- Physical-device and merchant sandbox reports are complete.
- Accounting owner, security reviewer and product/release owner sign the release decision.
- APK identity, signer, permissions, checksum, upgrade and rollback are verified.

## 3. External inputs required to finish the work

These cannot be safely invented or generated from source code:

1. An owner-authorized, redacted PMS backup and approval of the canonical accounting mapping.
2. The separate Pay Bridge source repository and permission to inspect/build it.
3. Provider-issued sandbox merchant credentials and current product/API-version documentation for providers intended for release.
4. CCAvenue's merchant-specific ordinary refund/status API contract and public egress allowlisting, if CCAvenue is to be enabled.
5. Supported physical Android devices/OS versions and access to run instrumentation and lifecycle tests.
6. Owner-controlled release signing identity and matching Pay Bridge signing configuration.
7. Production cloud project, IAM ownership, secret provisioning and named operational approvers, only if the optional online payment service is to be deployed.
8. Named accounting, security and release approvers for evidence sign-off.

Never commit credentials, private signing keys, customer backups or unredacted payment evidence to the repository.

## 4. Explicitly not required for the local-first PMS

- A cloud server to start or operate ordinary PMS features.
- Firebase login or internet access as a prerequisite for local booking, room, guest, folio viewing, reporting or manual payment recording.
- Mandatory cloud sync or multi-device sync.
- Offline gateway capture or deferred automatic charging.
- A separate cloud folio that competes with the device's canonical PMS accounting ledger.

These are outside the local-first core. Online payment processing and remote services remain optional capabilities with their own trust and release gates.

## 5. Implementation sequence and completion rule

Implement in this order:

1. **A — Canonical local database cutover**
2. **B — Canonical accounting and data reconciliation**
3. **C — Android persistence, backup and recovery qualification**
4. **D — Local device security and recovery**
5. **E — Optional online payment backend and intent lifecycle**
6. **F — Trusted Pay Bridge and local settlement**
7. **G — Refunds and reversals**
8. **H — Merchant UAT provider by provider**
9. **I — Optional cloud deployment and operations**
10. **J — End-to-end qualification and release**

A workstream is complete only when implementation, a regression test that fails if its invariant is broken, successful CI on the exact candidate SHA and any required real-world evidence are all present. Documentation, mocks, adapter availability or a passing web build alone do not close a workstream.

**Current release decision:** NOT PRODUCTION READY. Keep ordinary local PMS operation independent of internet/cloud. Keep live gateway collection, automatic settlement, automatic refund posting and release publishing locked until their separate acceptance criteria pass.
