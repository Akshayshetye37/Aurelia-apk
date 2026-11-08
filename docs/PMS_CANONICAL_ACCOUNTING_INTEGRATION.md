# PMS canonical accounting integration boundary

## Implemented in source

\`payment-backend/src/accounting/pms-ledger-mapping.mjs\` provides a pure, evidence-gated transformation layer from the actual PMS legacy payment model to the existing canonical journal proposal API.

| PMS / provider source | Required evidence | Canonical proposal |
|---|---|---|
| \`booking.pays[]\` payment row | Exact booking binding, integer \`amountPaise\`, independently verified provider capture bound to transaction/provider/amount/payment ID | Dr 2020 Gateway Clearing / Cr 1010 Guest Receivable |
| Provider settlement | Actual processor-reported fee and verified settlement ID; no percentage estimate | Dr 5010 Processing Expense / Cr 2020 Gateway Clearing |
| Booking cancellation row | Cancellation row belongs to booking, original capture journal, independently verified refund bound to parent payment and exact amount | Dr 1010 Guest Receivable / Cr 2020 Gateway Clearing |

All returned entries inherit the canonical journal's \`postingEligible: false\`, \`postingAuthorization: NOT_AUTHORIZED\`, and \`chartOfAccountsStatus: PROPOSAL_ONLY\` controls. The mapper performs no database writes, does not change booking balances, does not create a second ledger, and does not run on a scheduler. Tests cover evidence absence, identity/amount binding, fee evidence, parent linkage and debit/credit balance.

The actual PMS canonical legacy payment-row collection is \`booking.pays\`. \`booking.p\` and \`booking.payments\` are compatibility representations; they must not be independently imported as separate transactions. The cancellation mapping accepts a booking-owned cancellation row explicitly; the repository has not yet established a single authoritative persisted cancellation-row schema or provider-refund join for every historical record. Therefore this is a proposal adapter, not a complete historical migration.

## Why the supplied PostgreSQL DDL/DAO is not applied

Aurelia's current architecture is a local-first browser/Android PMS using IndexedDB/native SQLite repositories and a separate Firestore payment backend. The repository does not contain the proposed PostgreSQL \`payment_records\` or \`cancellation_log\` tables, nor a configured PostgreSQL pool or \`pg\` dependency. Adding those objects would create a parallel, disconnected accounting database rather than integrate the PMS.

The supplied scripts also have correctness defects independent of the storage mismatch:

- \`ADD CONSTRAINT unique_canonical_journal_id\` is not idempotent, despite the column additions being guarded.
- Backfilling with \`ROUND(amount * 100)\` assumes the source field is a trustworthy decimal rupee value and that every row is valid; forcing \`NOT NULL\` can fail on missing or malformed historical values.
- The trigger checks the existing row by ID instead of validating \`NEW.canonical_journal_id\`; it can reject valid transitions or fail to enforce the intended new-row invariant.
- \`linkCancellationReversal\` references an undefined \`client\` and does not use a transaction/lock or verify affected-row identity.
- A UUID-shaped identifier is not a cryptographic signature. The journal proposal currently uses a deterministic SHA-256 content identifier; neither value alone authorizes posting.

No schema mutation, legacy backfill, trigger, PostgreSQL service, or accounting writer has been deployed.

## Account 2020 finance anchor

The journal proposal's present debit/credit directions are internally balanced and reflect a *provisional clearing-asset model*. They do not establish the approved chart of accounts. Finance must document the legal/economic nature of gateway funds, normal balance, settlement timing, gross-vs-net treatment, chargebacks, fee tax treatment, reconciliation ownership and opening/closing balance process before account 2020 is approved. The mapping must not be silently inverted to match a guessed normal balance.

## Android release-chain work

\`scripts/patch-android.js\` now copies \ \`android/templates/security/proguard-rules.pro\` into the generated app module and wires it into the release build type for Groovy and Kotlin Gradle DSL projects. The rules preserve the Razorpay, Cashfree and Paytm SDK package surfaces and suppress only their missing optional warning classes.

This is a source-generation change, not evidence of a successful Android build. It does not enable R8 minification, create a production keystore, expose signing passwords, extract a signing digest, configure Play Console, or grant IAM roles. Those steps require the actual generated Android project and owner-controlled credentials. The release keystore fingerprint must be extracted from the *Play App Signing certificate* for app-distributed builds (the upload key fingerprint can differ); it must not be copied from a debug key. The backend service identity should receive only the narrow Play Integrity decode permission required by the selected API setup; broad Project Viewer is not a substitute for API authorization and least-privilege IAM review.

## Device enrollment boundary

The existing server-side enrollment protocol already issues a short-lived tenant/device-bound challenge, verifies the Play Integrity token server-side, verifies hardware key attestation, and leaves owner activation separate. A client-supplied model, OS version, \`Build.FINGERPRINT\`, UUID, or timestamp is informational telemetry only and cannot authorize a device. A \`201\` response from a generic registration endpoint must never unlock payment operations. Enrollment UI integration, generated Android compilation, Play Console linkage, real-device acceptance and owner recovery/reset flow remain outstanding.

## Release decision — unchanged

- Live gateway collection: **OFF**
- Automatic settlement: **OFF**
- Automatic refund posting: **OFF**
- CCAvenue: **disabled / not implemented**
- Production-qualified providers: **0 of 6**
- Account 2020 normal balance: **Finance approval pending**
- Canonical journal writer / scheduled reconciliation: **not connected**

The next permitted step is a read-only migration inventory and a Finance-approved account mapping. Only after the canonical PMS book, transaction identity joins, amount semantics, and rollback strategy are evidenced should a transactional writer be designed. No cron/scheduler should be added before that approval.
