# Aurelia UPI — Local-First Collection and Reconciliation

Aurelia UPI is the only payment rail exposed by the PMS payment UI. The implementation is local-first: it creates UPI intents and QR codes on-device, records collection sessions in the encrypted PMS repository, observes optional Android notifications, and requires a local operator to verify the bank credit before posting a payment to a folio or dining ledger.

## Sovereign PMS shell

The supplied sovereign PMS HTML is used as the visual reference, while the existing Aurelia PMS business logic and data model remain the source of truth. The primary navigation is now **Overview → Chambers → Stays → Dining → Vault → Aurelia UPI**. The Vault opens the existing settings, guest, housekeeping, inventory, report and backup sections as a tile-based workspace rather than a dropdown.

The responsive header carries the property identity, fixed INR currency, language indicator, theme toggle, profile/settings shortcut and local-node status. The overview exposes a direct **Aurelia UPI** collection shortcut. The shell styling is packaged in `assets/aurelia-sovereign-theme.css`; it does not load Tailwind, Google Fonts or icon fonts from a CDN. Existing invoice and spreadsheet export utilities remain version-pinned and are loaded only when those export actions are requested. The theme switch persists locally.

## Payment policy

- Rail identifier: `AURELIA_UPI`; customer-facing label: **Aurelia UPI**.
- Currency: INR only.
- One receiving VPA is configured in **More → Settings → Aurelia UPI ID (VPA)**. There is no demo VPA and no restaurant-specific alternate VPA.
- No payment gateway, aggregator, merchant API, webhook, card rail, cash rail, or automatic settlement is enabled.
- UPI intent launch is restricted to `upi://pay` with a valid `pa`, positive two-decimal `am`, and `cu=INR`. The native bridge rejects other custom URI schemes.
- QR generation uses the pinned local `qrcode` package and SVG output. No hosted QR endpoint is used.

## Collection lifecycle

1. A folio or open dining table creates a collection session with an immutable amount in integer paise.
2. Only one session per receiving VPA is active. Additional sessions are FIFO queued.
3. The active UPI intent/QR has a five-minute payment window.
4. A customer returning from a UPI app can be marked **Customer says payment sent**. This starts a 30-second verification window; it is a claim, not proof of payment.
5. An incoming bank/UPI notification or manual alert import is matched by amount, time, UTR and sender VPA where available.
6. A match is only a suggestion. The operator must check the receiving bank account and explicitly confirm the credit.
7. Only after manual verification does Aurelia post the amount to the existing folio or dining ledger. The session reference is retained for idempotent retries.
8. A rejected claim releases the FIFO queue. A review-pending session blocks the next collection for that VPA.

Terminal and review states are retained in the encrypted repository and audit trail. A notification, UPI app return, customer claim, or QR scan can never settle a payment by itself.

## Financial integrity hardening

- Payment, evidence, refund and audit identifiers require Web Crypto cryptographic randomness. There is no timestamp or `Math.random()` fallback; if a secure random source is unavailable, record creation fails closed.
- Financial audit records are persisted through the encrypted native repository and transactional outbox before they are shown as durable in the UI. An audit persistence failure is surfaced as an error rather than silently ignored.
- A bank UTR/reference is required before an operator can confirm a payment. The native SQLCipher database claims each reference in a dedicated table with a unique primary key and a unique (reference type, entity) constraint. A repeated claim for the same entity and amount is idempotent; reuse by another payment/refund or with altered details is rejected.
- Payment and refund transfer references share the same uniqueness namespace for the configured receiving VPA. Claims are permanent audit identities; corrections require a reviewed financial adjustment, not silent release/reuse.
- The native schema migration advances to version 9, creates the reference-claim table, and backfills existing manually verified payment/refund UTRs before the uniqueness rule is enabled. Conflicting legacy references fail the migration closed.

These controls strengthen the local device's financial ledger. They do not make notification text authoritative, prove bank settlement, or replace receiving-account verification.

## Android notification observer

The optional `AureliaUPINotificationListener` is registered as an Android `NotificationListenerService`. The operator must enable Notification Access in Android settings.

- Source packages are allowlisted and alerts are content-filtered for credit language plus UPI/VPA/UTR indicators. The Gmail Android app is an optional source when a bank-credit email notification is actually delivered to the device; Gmail OAuth, inbox API access and mailbox scraping are not enabled.
- Amounts are parsed with decimal arithmetic and stored as integer paise.
- UTR/RRN and sender VPA are extracted where present.
- Duplicate UTRs and same-UTR/different-amount conflicts are flagged.
- Raw notification evidence is stored only in the SQLCipher-backed PMS database.
- The observer does not request `READ_SMS`, does not read the SMS inbox, and does not send notifications to a remote service.
- Google Messages and Samsung Messages are included only so bank/UPI alerts delivered as message notifications can be recognized. Android Notification Access can expose notification previews from those apps to the listener; only credit-like UPI notifications are persisted.
- If the encrypted PMS store is locked, the observer does not create a plaintext fallback; that notification is not persisted.

Notification Access is sensitive. Enable it only on the device used to operate Aurelia PMS and only if the operator accepts the scope of the allowlisted notification sources, including message-notification previews.

## Reconciliation and refunds

- Manual alert paste/import, local Android notifications and bank-statement CSV rows enter the same review workflow.
- The CSV importer supports common comma- or semicolon-delimited exports with date, narration/description, credit (or amount plus CR/type), UTR/RRN and optional debit columns. It extracts dated UPI credit rows with exact amount and UTR/RRN, discards debit/non-UPI rows, and stores only the normalized candidate row—not the original statement file. Import batches are capped at 500 rows.
- Unmatched and ambiguous alerts can be assigned to an exact-amount session for manual review.
- Statement imports remain operator-supplied evidence. They do not settle payments automatically; the operator must inspect the receiving bank record and explicitly confirm.
- Confirming one session marks other alerts linked to that session as duplicates.
- Refund creation records a refund obligation only. Aurelia does not initiate a transfer.
- After the operator completes the refund in the bank/UPI app, they record the transfer UTR and explicitly attest that the transfer was verified.

## Deliberately excluded integrations

The upstream YouPI-PG repository is an experimental reference project and states that it is not bank/NPCI approved. Aurelia adopts its useful local collection concepts—FIFO, timers, QR, notification parsing and manual reconciliation—but does not copy its remote service architecture or credentials.

The following are not enabled in Aurelia UPI:

- WhatsApp OTP or WhatsApp session automation; this requires a separate remote WhatsApp session service and is not part of the local-first PMS.
- Gmail OAuth, Gmail API inbox access or Google Messages account/API access; Gmail bank-alert previews may be observed locally only when the Gmail app posts a notification.
- SMS inbox permission or automatic SMS ingestion.
- Remote observer API, HMAC webhook delivery, merchant API or payment-provider gateway.
- Cash, card, COD or other non-UPI payment methods.

These exclusions keep the payment flow local, avoid third-party credentials, and preserve the requirement that only Aurelia UPI is used.

## Build and verification

- Runtime: Node.js 22 or newer.
- `npm install --no-audit --no-fund`
- `npm test`
- `npm run build`

The web build bundles only the `qrcode` core encoder and SVG renderer through a small esbuild browser entry, smoke-tests SVG generation, and copies the Aurelia UPI modules and CSS into `www/`. This avoids the missing precompiled bundle in qrcode 1.5.4 and excludes its Node-only PNG/stream dependencies. Android template patching registers the notification observer and the constrained native UPI intent bridge.

APK workflows are manual-dispatch only. Do not build or install an APK until the owner explicitly approves device verification.
