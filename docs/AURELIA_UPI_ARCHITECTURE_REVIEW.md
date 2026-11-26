# Aurelia UPI — Architecture Review and Adoption Decisions

**Status:** Engineering decision record  
**Reference reviewed:** User-supplied YOUPI PG V2 architecture excerpt  
**Scope:** Aurelia PMS / Android local-first payment collection  
**Decision:** Adopt selected workflow patterns; reject gateway/server assumptions that weaken the local financial trust boundary.

## 1. Executive decision

Aurelia UPI is a direct-to-receiving-VPA collection and reconciliation module inside Aurelia PMS. It is not a self-hosted payment gateway, payment aggregator, merchant API platform, or bank-observation authority.

The YOUPI PG document is a useful feature reference, not a production security specification. Its claims of cryptographic bank verification and instant settlement from one observation are not accepted. An HMAC proves that a payload was produced by a holder of an observer secret; it does not prove that the bank credited the account. SMS, push notifications, email, QR scans, UPI-app returns, customer claims, and webhook delivery are not settlement proof.

The authoritative operator action remains: inspect the receiving bank account or bank statement, verify the actual credit, amount, receiving account and transaction reference, then explicitly confirm in Aurelia UPI. A confirmed record must retain the operator decision and durable audit trail.

## 2. Adopted capabilities

| Reference capability | Aurelia UPI implementation / policy |
|---|---|
| Amount-only UPI intent and QR | Keep amount-specific UPI URI and on-device QR rendering. Do not send payment metadata to third-party QR endpoints. |
| Single active slot and FIFO queue | Keep a per-VPA local collection queue. Treat it as a single-device operational workflow, not a cross-device/distributed lock. |
| Payment and verification timers | Keep five-minute active window and 30-second customer-reported verification window as UX/workflow deadlines. Expiry never proves that funds were not received. Late evidence remains reviewable. |
| Integer minor-unit money | Keep INR paise as positive safe integers. Never use floating-point arithmetic for ledger amounts. |
| Bank observation | Keep allowlisted Android notification evidence as untrusted input. No L1/L2/L3 tier can transition a session to confirmed. |
| Statement import | Keep dated UPI credit parsing, explicit receiving-VPA confirmation, exact amount matching, UTR deduplication and manual review. |
| Reference replay protection | Keep SQLCipher-backed unique reference claims scoped to receiving VPA, with idempotent same-entity retries and fail-closed conflicts. |
| Recovery and audit | Keep durable local entity writes, transactional outbox intent, explicit retry paths and awaited audit persistence. |
| Refund records | Keep manual refund requests and manually verified transfer references. Aurelia UPI does not initiate bank transfers. |

## 3. Rejected capabilities

The following YOUPI PG features must not be ported into Aurelia UPI:

- Baileys / WhatsApp OTP customer identity, gateway-owned customer accounts or browser bearer-token profiles.
- Remote merchant checkout APIs, universal merchant SDKs, hosted gateway checkout pages, gateway webhooks or remote fulfillment callbacks.
- Cash on delivery, cash counter, card counter, POS acquiring, or additional payment rails.
- Automatic settlement based on one observer, multi-observer quorum, browser events, customer confirmation, UTR text alone, or signed notification payloads.
- Gmail/Google OAuth inbox polling or Google Messages Web CDP scraping. These add broad account/device access and external credential surfaces without making the bank signal authoritative.
- Gateway process supervisors, public REST/SSE payment core, or claims of server-authoritative timers. Aurelia UPI is a local PMS module; its current timers are local workflow state, not server-clock guarantees.

## 4. Financial trust model

### Evidence hierarchy

1. **Bank account / bank statement reviewed by an authorized operator:** authoritative basis for manual confirmation.
2. **Native notification, SMS/email text, imported alert, UPI app return:** untrusted evidence that can suggest a candidate and assist reconciliation.
3. **QR scan, app launch, customer "paid" action, browser callback:** workflow signals only; never evidence of credit.

The evidence parser must be conservative. A parsed amount, UTR or sender VPA is not proof that the receiving account was credited. Exact amount equality is necessary for candidate matching but is not sufficient for confirmation.

### Confirmation gate

A payment confirmation must fail closed unless all of the following are true:

- The operator explicitly confirms that the credit is visible in the receiving bank account / trusted statement.
- INR amount in paise exactly equals the collection amount.
- The receiving VPA is the configured account for the collection.
- A valid bank transaction reference is present and successfully claimed in encrypted native storage.
- The reference is not already claimed by another payment/refund entity in that receiving-VPA namespace.
- The payment and audit changes are durably persisted; PMS posting is separately idempotent and recoverable.

A notification or parser must never call the confirmation path directly.

## 5. Persistence and concurrency boundaries

- SQLCipher is the intended protected local store. Browser localStorage/IndexedDB is not an equivalent encrypted substitute.
- The current SQLCipher entity repository and UPI reference-claim table provide important native persistence controls, but this does not mean every PMS business read/write has completed canonical-store cutover.
- The FIFO queue is currently computed in the Aurelia UPI domain/application layer and persisted as entity changes. It must not be described as a database-enforced global single-slot lock or multi-device arbiter.
- If multiple independent devices are ever allowed to collect against one VPA concurrently, a separate authoritative coordination service or a tested shared transactional store is required. Do not simulate distributed locking with local entity snapshots.
- Reference claim and payment-record persistence are separate recoverable operations. The same entity/amount retry must remain idempotent; a conflicting entity/amount must fail closed and surface for operator recovery.
- Expired/cancelled requests may still receive late credits. Do not automatically discard late bank evidence or conclude that the payer was not debited.

## 6. Timers and state machine

The five-minute active window and 30-second verification grace are operational timers only. They are not bank settlement deadlines.

- Timer state must be persisted, restored and re-evaluated after process death.
- A local device clock is not a trusted server clock. Clock changes, reboot, process suspension and time-zone changes must be included in device qualification.
- When the verification grace elapses, move the session to manual review; do not mark it as a confirmed failure or assume no funds moved.
- A late matching credit must remain eligible for review against the original session, with duplicate and reference-replay protections.

## 7. Security controls and release gates

### Implemented source-level controls on the financial-hardening branch

- Cryptographically secure record identifiers; no weak random fallback.
- Awaited audit persistence.
- Mandatory bank reference claim before payment confirmation.
- SQLCipher-backed unique reference claims scoped to receiving VPA, with v8→v9 legacy backfill that aborts on conflicts.
- Refund transfer-reference claim.
- Explicit receiving-VPA confirmation for statement imports and cross-VPA match rejection.
- Notification evidence remains separate from payment settlement.

### Not yet qualified for production

- SQLCipher canonical-store cutover for all live PMS business reads/writes.
- Physical-device v8→v9 migration, legacy backfill conflict, interruption, rollback and restore testing.
- Device unlock, PIN/biometric/recovery lifecycle, process death, reboot, lockout and lost-device tests.
- Multi-action financial concurrency, UTR replay, crash recovery between claim/payment/PMS posting, refund cumulative limits and duplicate observer tests on device.
- Real-bank statement and notification behavior under controlled testing.
- Independent security review and release qualification.

No live payment automation, gateway/provider integration, automatic settlement, deployment or release is authorized by this architecture decision.

## 8. Acceptance criteria for future changes

1. No observer, customer action, browser event or UPI app callback can create a confirmed payment.
2. No payment/refund reference can be replayed against another entity in the same receiving-VPA namespace.
3. Every financial state change and operator decision has a durable audit event or fails closed.
4. Amounts remain integer paise from input through persistence and PMS posting.
5. Queue recovery preserves FIFO order and never promotes while an unresolved/manual-review or pending-PMS-posting owner still holds the slot.
6. Late credits remain reviewable after local timer expiry.
7. No new payment rail, external gateway, remote merchant API, webhook or automatic settlement is added without a separate explicit architecture/security decision.
8. Production readiness is not claimed until canonical storage and physical-device qualification are complete.

---
This review covers only the supplied excerpt. Its section 4.7 is truncated after the beginning of Tier 1; no missing branding requirements have been assumed.
