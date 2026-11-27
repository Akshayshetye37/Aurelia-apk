# Aurelia PMS feature-completeness audit — 27 November 2026

## Scope and method

Reviewed the maintained `main` entry point, README and security/architecture documentation, the Aurelia UPI modules, Android templates and build scripts, the current regression tests, and selected historical branches for branding, checkout, backup, persistence and printing.

This is a source audit. It does not claim a physical-device run, successful Google OAuth consent, a completed database migration, or production qualification.

**Payment scope:** direct Aurelia UPI, cash and bank transfer only. Third-party payment gateway/provider integrations, SDKs and gateway-dependent features are explicitly excluded.

## Main-branch capabilities confirmed in source

| Area | Current source capability | Assessment |
|---|---|---|
| Property operations | Rooms, availability, reservations, guest profiles, check-in/out, stay extension and booking lifecycle | Present |
| Guest records | Contact data, identity fields, occupants and vehicles | Present; privacy/access review still required |
| Folios | Room charges, payments, balance calculation, invoice preview and checkout | Present |
| Direct UPI | Local exact-amount UPI intent/QR, folio/dining-linked requests, FIFO queue, expiry, WhatsApp sharing, alert evidence, manual bank verification and retryable PMS posting | Present in the web payment module; requires native encrypted UPI storage for production |
| Cash / bank | Manual receipt confirmation, amount bounds and optional reference/UTR | Present |
| Dining | Table tickets, menu categories/items, inventory-linked sales and separate dining ledger | Present; table selection styling was ambiguous |
| Housekeeping | Cleaning queue, out-of-service and room release | Present |
| Inventory | Stock movements, reorder thresholds and sellable POS stock | Present |
| Finance | Expenses, financial ledger, reports and CSV exports | Present |
| Administration | Audit trail, property/restaurant identity, tax/check-in/out settings and optional HTTPS booking feed | Present |
| Recovery UI | Verified JSON export/import and native device restore-point actions | Present, but not equivalent to a fully qualified encrypted off-device recovery system |

## Verified gaps and incomplete integrations

### P0 — persistence authority and safe recovery

- The maintained README says the Android SQLCipher repository is not yet the canonical live store for PMS business records. The current HTML still owns operational state through browser storage/IndexedDB.
- The generic `SAVE BLOCKED` message was overwriting the more useful original load/migration failure on subsequent renders. This audit branch now preserves the original diagnostic.
- Do not bypass blocked writes, clear old storage, or silently initialize empty state when an existing record cannot be read.
- Before claiming native SQLCipher-backed PMS storage, finish the repository bridge, schema migration, verified read-back, rollback and restore tests, and physical-device cutover verification.

### P0 — Google identity and account model

- No Google Sign-In authentication flow is integrated in maintained `main`.
- A historical branch, `docs/google-device-credential-snapshot-2026-11-22`, contains a native Credential Manager Google ID-token flow (`GooglePrimaryAuthActivity`), Firebase Auth sign-in, a server-side `ensureOwnerMembership` callable, and App Check/Firestore membership contracts. It is a staging foundation, not a maintained-main feature or proof of live Firebase configuration.
- That primary-auth snapshot is 3,775 commits ahead and 357 behind main at audit time. Its Android/Firebase modules, rules, deployment workflow and tests must be selectively reviewed and ported; the branch also contains unrelated payment-backend work that is explicitly excluded.
- The historical Drive-backup implementation explicitly treats Google Drive authorization as separate from Google Sign-In. A Drive grant must not be represented as PMS login.
- A production sign-in still needs the actual Firebase project configuration, Web OAuth client ID, exact Android package/signing fingerprints, App Check/Play Integrity deployment and physical-device verification. No client secret or service-account credential should be embedded in the APK.

### P1 — encrypted Google Drive backup

- Maintained `main` exposes JSON export, device restore-point, folder and JSON restore controls; it does not include the complete encrypted Google Drive backup UI/adapter.
- Historical branch `feature/owner-google-drive-backup-v2` contains a separate Drive adapter, AES-256-GCM envelope validation, PBKDF2 recovery-password wrapping, narrow `drive.appdata` authorization, account display, history/restore, retention and schedule controls.
- That branch is heavily diverged from main (3,753 commits ahead and 356 behind at audit time). Its build script also packages unrelated payment modules. It must not be merged wholesale. Only the backup-specific adapter, vault, Android authorization bridge, UI and tests should be selectively ported after dependency/security review.
- Scheduled backup is best-effort while Aurelia is running/foregrounded; the historical architecture documentation explicitly says a stopped WebView cannot create a fresh snapshot. Do not promise unattended background snapshots until the data source and key access are native/background-capable.
- Restore must validate the encrypted envelope and schema, verify the recovery password, preserve the current recovery point, and complete rollback-safe state/photo restoration before reporting success.

### P1 — property branding

- Maintained `main` had no property logo setting or persisted logo asset.
- The older branding branch only previews a selected file using an object URL; its save handler does not persist that file. It is not a completed upload implementation.
- This branch adds validated PNG/JPEG/WebP upload, resizing and size limits, persistence in property settings, and rendering in the application identity, invoice and thermal receipt.

### P1 — checkout and UPI hand-off

- Main already routes checkout to the Aurelia UPI collection module. The module generates the exact-amount QR and guest-shareable UPI URI, supports WhatsApp sharing, and requires staff to verify receiving-bank credit before posting.
- The active-session UI also exposed an “Open UPI app” action on the operator's device. This branch removes that action and provides a copyable payment link; the guest opens the link or scans the QR on their own device.
- No payment notification, QR scan or customer assertion may auto-settle a folio.

### P1 — Folios and responsive layout

- The PMS shell and payment module both rendered an open-balances section, producing duplicate/competing layout. PR #92 removes the duplicate and lets the UPI module own that panel.
- The UPI workspace now uses the PMS content width and card/theme tokens.

### P1 — dining table selection

- Occupied tables and the active table both used the same gold border/background treatment. A table with an open order could therefore look selected even when another table was active.
- This branch separates the active selection outline from the occupied-ticket indicator. Only the active table receives the selected ring.

### P1 — invoices and receipts

- Main used one generic `window.print()` action and fixed-position print content. Fixed-position content can repeat when a print document spans multiple pages; the generic action also did not explicitly constrain printing to one active document.
- This branch selects exactly one invoice/receipt print area and uses normal document flow for print layout.
- A native durable Bluetooth/ESC-POS print queue is not integrated into main. Historical `feature/bt-printing` contains a print queue, receipt layouts and transports, but its feature flag defaults to disabled. It requires separate hardware/device qualification before enabling.

## Historical branch disposition

| Branch | Relevant work found | Disposition |
|---|---|---|
| `feat/folio-checkout-cash-whatsapp-20261127` | Checkout cash confirmation and direct UPI/WhatsApp flow | Main already contains the core UPI route and related contracts; cherry-pick only a demonstrable missing behavior |
| `work/brand-timezone-dashboard-20261127` | Hotel logo file preview | Preview-only; not a durable upload |
| `docs/google-device-credential-snapshot-2026-11-22` | Google Credential Manager sign-in, Firebase owner membership and App Check contracts | Staging foundation; 3,775 ahead / 357 behind; selectively port only after Firebase and Android configuration review |
| `feature/owner-google-drive-backup-v2` | Encrypted Drive backup, restore and native Drive authorization | Valuable candidate; too diverged for wholesale merge |
| `feature/phase-7-pms-persistence` / `fix/p0-storage-authority` | PMS storage-authority and recovery work | Review module-by-module; do not claim canonical cutover without verified integration |
| `feature/bt-printing` | Printer catalog, print queue, ESC/POS/ZPL and transports | Feature disabled by default; separate device qualification required |
| `work/feature-completion` | Older consolidated HTML iteration | 210 commits behind main; not a safe replacement |

## Changes made on the audit branch

- Preserved the original persistence load/migration diagnostic when saves are blocked.
- Added property logo validation, resizing, persistence and use in app identity/invoices/thermal receipts.
- Distinguished selected dining table from other occupied tables.
- Constrained print output to one active invoice/receipt and removed fixed-position print duplication behavior.
- Removed operator-device UPI-app launch from the active collection UI; added copy-link while retaining guest WhatsApp sharing and QR.
- Retained manual receiving-bank verification and no automatic settlement.
- Retained the PR #92 single Folios payment workspace and responsive layout repair.

## Not represented as complete

- Google Sign-In / PMS account authentication.
- Encrypted Google Drive backup and restore in maintained main.
- Native SQLCipher as canonical PMS operational storage.
- Fully unattended backup while the app is stopped.
- Native Bluetooth printer queue in maintained main.
- Physical-device verification of UPI, encrypted storage, logo persistence, print output, OAuth, backup and restore.

## Acceptance criteria for the remaining work

1. **Storage:** existing PMS data is read and migrated without loss; failed reads/writes preserve source records and expose the root diagnostic; rollback and backup restore pass on a physical Android device.
2. **Google Sign-In:** identity is separate from Drive authorization; account/session revocation and authorization checks are tested; no secrets are shipped in the APK.
3. **Encrypted Drive backup:** only authenticated encrypted envelopes are uploaded; tokens remain transient; account switching, expiry, pagination, retention, recovery-password handling and restore rollback are tested.
4. **Branding:** uploaded logo survives app restart, backup/restore and theme changes; invalid formats and oversized files are rejected.
5. **Checkout:** the guest receives an exact-amount UPI link/QR; the operator does not initiate payment on the guest's behalf; bank verification is mandatory before PMS posting.
6. **Dining:** one selected table at a time; occupied-ticket state remains visually distinct; switching tables never moves or duplicates order lines.
7. **Printing:** exactly one invoice or receipt is sent to print; multipage output has no repeated duplicate document; receipt/invoice data matches the PMS ledger.

**Release rule:** no data cutover, cloud backup activation, or printer feature enablement until the corresponding migration/restore or device-level acceptance tests are green.
