# Aurelia PMS

Aurelia PMS is the property-management application maintained in this repository.

## Project location

- **Repository:** https://github.com/Akshayshetye37/Aurelia-apk
- **Maintained branch:** `main`
- **Application entry point:** `index.html`
- **Android packaging:** Capacitor configuration and the maintained Android templates/build scripts in this repository.

## Payment security boundary

**Aurelia UPI is currently the only enabled payment collection method in Aurelia PMS.** No third-party gateway provider is currently integrated or enabled on `main`.

The planned payment architecture is **Aurelia PayBridge**, a first-class integration subsystem inside Aurelia PMS. PayBridge is intended to connect PMS to a separate, optional Android companion application named **Aurelia Gateway**. The design is documented below; this is an architectural plan, not a claim that PayBridge, Aurelia Gateway, or any provider integration is implemented or production-ready.

Current restrictions remain in force:

- Razorpay, Cashfree, PayU, PhonePe, Paytm, JioPay, CCAvenue and other provider integrations are not currently enabled in PMS.
- Card, bank-transfer and third-party mobile-money choices are not currently offered as live payment methods.
- Provider SDKs, provider credentials, gateway checkout and provider webhook processing are not enabled in the PMS main application.
- Payment collection controls fail closed: the active collection flow exposes Aurelia UPI only and rejects non-UPI method selections.
- Historical provider-integration branches are development material, not enabled configuration for `main`. Do not merge provider implementations or activate payment rails without explicit review and end-to-end qualification.

The intended PayBridge architecture does not change these current restrictions. Any future activation requires implementation, security review, provider-specific qualification and verified end-to-end testing. A saved preference, installed companion app or successful client-side response must never activate a provider or establish that a payment has settled.

## Aurelia PayBridge and the future Aurelia Gateway app

### Product overview

PayBridge is planned as a built-in subsystem of Aurelia PMS. Its purpose is to give PMS one stable, provider-independent interface for payment gateway capabilities supplied by a separate Android companion application, **Aurelia Gateway**.

Aurelia Gateway is planned as an optional install. A PMS user who needs third-party gateway processing would install both applications, authorize their connection, configure a gateway/provider in Aurelia Gateway, and then use the capabilities made available to PMS through PayBridge. Users should not need a custom PMS integration for every provider.

### Application responsibilities

**Aurelia PMS / PayBridge owns:**

- PMS payment intents, booking folios, invoices, balances and the canonical payment ledger.
- Gateway-app discovery, authenticated connection state and user-approved connection authorization.
- Reading the gateway app's versioned capability catalogue and presenting supported payment options.
- Routing payment requests to the selected, authorized gateway/provider.
- Validating the returned transaction evidence before the PMS records a payment.
- PMS-side audit references, idempotency and reconciliation state.

**Aurelia Gateway owns:**

- The provider catalogue and provider-specific integrations (for example, Razorpay, PayU, Cashfree, Jio and other providers where supported and commercially enabled).
- Provider onboarding/configuration and provider-specific checkout flows.
- Provider API communication and provider transaction references.
- Obtaining authoritative transaction status/evidence from provider services and reporting it through the agreed protocol.
- Provider-specific capabilities and limitations, exposed to PMS through a capability catalogue.

The provider examples are illustrative. Actual payment methods, refunds, settlement, availability and other capabilities must be confirmed against each provider's current APIs, commercial terms and eligibility.

### Intended connection and payment flow

1. PMS checks whether the genuine, compatible Aurelia Gateway app is installed.
2. The applications establish a versioned, authenticated connection. The owner explicitly authorizes the pairing; installation or discovery alone does not establish trust.
3. Aurelia Gateway exposes its supported providers, payment methods and capabilities. PMS displays only options that are configured, supported and enabled.
4. PMS creates a uniquely identified payment intent and sends it through PayBridge to the selected gateway application/provider.
5. Aurelia Gateway conducts the provider-specific payment workflow and obtains transaction evidence.
6. PayBridge validates the response and its correlation to the original intent. For production payments, authoritative status must be verified through a trusted backend/provider API or a cryptographically authenticated server notification—not merely a client-side success screen, redirect or app-to-app message.
7. The canonical PMS payment service applies an idempotent state transition and records verified payment evidence in the PMS ledger. Gateway applications must never write directly to or independently alter the PMS ledger.

### Integration and security principles

- Use a documented, versioned IPC/API contract so the gateway app can evolve independently of PMS. Android implementation may use signature-protected bound services/AIDL or another reviewed IPC mechanism, with package visibility and lifecycle constraints handled explicitly.
- Separate app discovery, app authentication, connection authorization and payment authorization; they are distinct security decisions.
- Keep provider secrets and authoritative signing credentials in an appropriately secured backend, not in browser storage, source files, APK resources or client-side configuration.
- Authenticate and integrity-protect messages; validate request IDs, amounts, currency, merchant/account context, timestamps and transaction references.
- Enforce idempotency, replay protection, duplicate-callback handling, explicit pending/failed/cancelled/refunded states and auditable reconciliation.
- Treat provider capability declarations as input to the UI, not as proof of successful payment or settlement.
- Keep provider failover and automatic routing disabled unless explicitly configured, tested and approved. Never silently retry a payment in a way that could charge the customer twice.
- Keep the existing Aurelia UPI flow and ledger behavior isolated from future gateway adapters until the new integration passes its own acceptance and regression gates.

### Current implementation status

**Integration foundation added; end-to-end connection not yet device-qualified.** The main branch now contains the PMS-side PayBridge protocol constants, signature-checked Messenger client, native Capacitor plugin, explicit PMS consent dialog, and Settings connection controls. The separate Android companion application scaffold (Aurelia Gateway) is on the `gateway-provider-files` branch. Its service requires the Gateway user's local pairing approval and a matching application signing identity. Protocol v1 currently supports the authenticated handshake only and advertises no provider-management or payment capability. The two APKs have not yet been installed and tested together on a physical device. The current payment collection policy remains Aurelia UPI only; no third-party gateway, automatic settlement or provider routing is enabled.

## Payment accounting

Booking folios, payment history, guest balances, cancellation records and accounting journals are PMS business records and are retained. Disabling provider gateways must not erase or rewrite historical payment records. Only the payment collection method is restricted.

A UPI intent/QR is a payment request, not independent proof of settlement. Staff must verify receipt in the receiving UPI/bank account before recording a payment as received.

## Aurelia UPI workspace

The Aurelia UPI collection, notification evidence, FIFO queue, manual reconciliation, refund register and local QR implementation are documented in [docs/AURELIA_UPI.md](docs/AURELIA_UPI.md). The Aurelia PMS shell uses Overview, Chambers, Stays, Dining, Vault and Aurelia UPI as primary navigation. The supplied HTML is used as the visual reference; its static demo data and simulated payment confirmation are not used as production settlement logic.

## Frontend, interface system and runtime contract

The maintained frontend is the complete, data-driven [index.html](index.html) application. Its existing renderers, application state, persistence adapters, booking lifecycle, folios, dining/POS and Aurelia UPI workflows are the source of truth. Do not replace this application with a static mockup or add hard-coded sample properties, guests, reservations, occupancy, revenue, balances or payment outcomes.

The visual system is maintained in [assets/aurelia-sovereign-theme.css](assets/aurelia-sovereign-theme.css) and [assets/aurelia-upi.css](assets/aurelia-upi.css). The current design direction is deep forest emerald, muted champagne gold, warm ivory and restrained translucent surfaces, with responsive cards, editorial headings, mobile-safe spacing, keyboard focus states and reduced-motion support. Typography uses local/system font stacks; no Google Fonts, remote icon font, Tailwind CDN or external stylesheet is required. The theme is presentation-only and must not change domain calculations, storage, authorization or payment state.

### Frontend security and data integrity

- Keep the Content Security Policy in the document head synchronized with actual runtime dependencies. It blocks frames, child frames and objects, restricts base/form targets, and limits script execution to the application plus the explicitly pinned invoice-rendering dependency.
- Invoice capture loads `html2canvas@1.4.1` only when that feature is invoked, from its exact jsDelivr URL with a fixed SHA-256 Subresource Integrity hash and anonymous CORS. If the dependency is upgraded, update the URL, integrity hash, CSP allowlist and relevant tests together. Do not load arbitrary script URLs.
- Inline scripts and inline event handlers remain in the legacy application, so the current CSP still requires `'unsafe-inline'`. This is a known hardening boundary, not a claim of strict nonce/hash-based CSP. Migrate inline code in a separately tested security change before removing that directive.
- Keep all business values sourced from the existing application state and durable storage. A failed or unavailable storage write must remain visible and fail closed; never fall back silently to volatile in-memory data or report an unsaved mutation as successful.
- A UPI QR/intent, customer claim, notification or client-side response is not proof of settlement. Keep payment posting behind the existing Aurelia UPI evidence-review and manual-confirmation flow.
- The HTML shell exposes a skip link, a named main landmark and a labelled primary navigation landmark. Preserve keyboard access, semantic controls, focus visibility and reduced-motion behavior when changing the interface.

### Build and verification

Use Node.js 22 or later:

```sh
npm install
npm test
npm run build
```

The build prepares the deployable web application under `www/`, copies the local CSS and application modules, bundles the QR engine locally, and performs an SVG QR smoke test. To inspect the prepared web app in a browser, serve that directory over HTTP rather than opening the source HTML through a `file://` URL:

```sh
python3 -m http.server 8080 --directory www
```

Then open `http://localhost:8080`. Android-specific capabilities still require the Capacitor/native wrapper; browser preview does not qualify native storage, permissions, payment collection or device security.


## Branch audit and adoption policy — 24 November 2026

A branch inventory identified 73 branches. Many feature, integration, backup and release branches are deeply diverged from `main`; branch commit counts and compare totals are not evidence that all changes are complete. GitHub compare responses for several large branches were capped at 300 changed files.

### Reviewed candidate work

- **PMS canonical persistence:** `feature/phase-7-pms-persistence` and `fix/p0-storage-authority` contain IndexedDB/native repository, migration, identity, outbox, and bootstrap work with dedicated tests. The code is a candidate architecture, not an adopted or production-qualified UI cutover. Its own documentation keeps synchronous UI cutover separate.
- **Folio and booking lifecycle:** `work/folio-booking-lifecycle` contains cancellation policy and folio/accounting tests. It needs domain integration and regression verification against the current UI before adoption.
- **Local payment receipt and proof:** `work/local-ledger-receipt` and `work/payment-ack-proof-hardening` contain local receipt/outbox and acknowledgement-vs-posting work. Any future adoption must be constrained to Aurelia UPI and must never interpret a QR/intent or device acknowledgement as settlement proof.
- **Encrypted backup and recovery:** `fix/backup-consolidated-integration`, `feature/owner-google-drive-backup-v2`, and related branches contain backup/restore and recovery work. They remain unqualified for production until native build, encryption negative cases, owner authorization, restore, and physical-device tests pass.
- **Authentication, Gate 3/5 and SaaS work:** these branches have open/draft reviews and staging/emulator/physical-device gates. They are not considered fully implemented merely because source code exists.

### Explicitly excluded from the active main application

Do not import multi-provider payment adapters, gateway SDKs, provider onboarding, gateway webhooks or automatic settlement from `feature/multi-provider-payment-backend`, `feature/payment-provider-production-adapters`, `feature/pay-bridge-platform`, or similar historical branches without a separate reviewed adoption. The approved direction is to design and implement PayBridge as a first-class PMS subsystem and connect it to the future Aurelia Gateway companion app through a versioned, authenticated protocol. The active payment collection boundary remains Aurelia UPI only until that work is implemented, qualified and explicitly enabled.

### APK workflow and verification boundary

Both `.github/workflows/android-apk.yml` and `.github/workflows/build-apk.yml` are manual-dispatch only on this feature branch. They do not run on push or pull-request events. Do not dispatch either APK workflow until the owner explicitly approves an APK build.

The separate `.github/workflows/android-native-compile.yml` workflow compiles generated Android Java sources with `:app:compileDebugJavaWithJavac`; it has no APK assembly or artifact-upload step and asserts that no APK file was produced. The Node contract workflow runs the source tests and local web bundle build. Treat each result as evidence only for the exact commit SHA reported by GitHub Actions.
### Branding

The maintained application name, package name, app title, and Capacitor app name are `Aurelia PMS` / `aurelia-pms`. Third-party platform names in security and integration notes refer to dependencies or disabled historical integrations, not alternate application branding or enabled payment methods.

## Run locally

Follow the [build and verification instructions](#build-and-verification) above. Android-specific features require a compatible Capacitor/native wrapper and its implemented bridge.

## Architecture and security baseline

The accepted offline-first, local-versus-server, storage, financial-integrity, offline-licensing and anti-cloning decisions are documented in [docs/ARCHITECTURE_DECISIONS.md](docs/ARCHITECTURE_DECISIONS.md). Android release patching now enables R8 minification/resource shrinking, disables release debuggability and WebView debugging, disables Android automatic app-data backup, and removes broad camera/legacy shared-storage permissions. Contract tests cover the manifest and release-hardening helpers (`npm test`).

The native SQLCipher repository foundation now requires a user unlock before it can obtain the one random 256-bit DEK. An 8–12 digit PIN and a high-entropy recovery key each have independent PBKDF2-HMAC-SHA256/AES-GCM envelopes for that same DEK; strong biometric unlock uses an authentication-per-use Android Keystore AES-GCM key. PIN and recovery secrets are entered in native dialogs, and the recovery key is displayed once for offline safekeeping. A local exponential delay is applied after failed unlock attempts. OTP/SMS is not accepted by the key manager and cannot derive, replace, wrap or regenerate the DEK. This is **not yet the canonical application store**: native storage is not wired to live business reads/writes, legacy-data migration and rollback are not connected to the live UI, and the HTML application still uses browser-side persistence. Do not cut over live data until native compilation, biometric/lockout negative cases, migration gates and physical-device checks pass. R8 does not protect WebView JavaScript; production JavaScript minification/obfuscation and signed offline licensing also remain outstanding.

This repository is a source project, not a declaration of production readiness. Review [docs/SECURITY.md](docs/SECURITY.md), verify the exact release build and test on supported physical devices before distribution. Do not place provider secrets in browser storage, source files, APK resources or client-side configuration.

## Payment policy verification

The main application must satisfy these checks before release:

1. Only the Aurelia UPI payment choice is visible in collection flows.
2. Non-UPI method submissions are rejected by application logic.
3. Provider gateway configuration and checkout interfaces are absent from the PMS main branch.
4. Existing folio and accounting records remain intact.


## Uploaded PMS workspace alignment

The active `index.html` now uses the uploaded emerald-and-champagne Aurelia PMS workspace as its application shell. It retains the workspace's room, reservation, folio, dining, guest, housekeeping, inventory, expense, reporting, audit and settings flows.

The Folios destination mounts the repository-backed Aurelia UPI payment desk from `src/aurelia-upi` and the local QR bundle. UPI requests are created with exact INR amounts, guest/folio references and saved guest phone numbers; WhatsApp uses the universal `wa.me` link so Android can route to WhatsApp Personal or Business. Staff must still send the prefilled message and verify receiving-bank credit before PMS posting. Incoming notification evidence is review-only.

Cash and bank transfer remain available for room folios and dining tickets. Cash/bank receipts require operator confirmation. Card/POS and external payment gateways are not enabled.

On first launch after this workspace change, `loadState()` checks the previous `aurelia_lodge_v2` browser record and maps its rooms, bookings, guest profiles, payments, dining orders, sales, settings and audit data into the uploaded workspace schema. The old key is retained; it is not deleted. If the previous data cannot be validated or migrated, writes are blocked and the recovery message is shown rather than silently starting with empty sample data.

The web build packages `assets/aurelia-upi.css`, the local QR engine and the Aurelia UPI module. No CDN chart, font or QR runtime is required.

## Identity, local operation, screen lock and cloud backup decisions

The following product decisions define the intended authentication, local-operation, screen-lock and cloud-backup experience. They are architectural requirements; their presence in this README does not claim that the native integrations are implemented or production-qualified.

### Operating modes and Google Sign-In

- Aurelia supports permanent **Local Mode** and optional **Google Sign-In**.
- The first-run welcome screen offers **Continue with Google** and **Use without login**.
- Google Sign-In is the only account-login method. Do not add email/password login, email verification, SMS OTP or recovery-key prompts to the Google login flow.
- Use Android Credential Manager for Google account selection. Present eligible accounts through Google's supported account picker; allow the user to choose or add another Google account through that flow.
- Validate the Google ID token with Firebase Authentication, then independently verify the authenticated UID's owner/property membership before granting cloud-linked owner access.
- An authenticated but unauthorized Google account must not silently create a new property or gain access to an existing property.
- Local Mode is not a trial or restricted demo. Core PMS operations use the same PMS engine and business rules in both modes and remain available offline.
- Keep Google account identity, Aurelia owner identity, tenant/property identity and device/installation identity separate.
- A Local Mode property may later be linked to an authorized Google owner from Settings. Linking must preserve the existing property ID, device identity and all local business records; it must not create a duplicate property or overwrite local data.
- Signing out of Google or losing cloud authorization must not delete or disable the local property and its locally available PMS operations.

### App screen lock

- The **Use Screen Lock** control is available from the Dashboard and Settings.
- When enabled, Aurelia uses Android's native device-credential authentication prompt (PIN, pattern or password, with supported biometric options where configured). Aurelia does not create, store or compare a separate copy of the device passcode.
- Authenticate when a new Aurelia app process starts after the previous process was killed while in the background.
- After one successful authentication, keep the app unlocked for the lifetime of that process. Do not prompt again for ordinary navigation, temporary backgrounding, notification-shade use, app switching or activity recreation while the process remains alive.
- A process restart requires authentication again when the feature is enabled.
- Use the device's currently configured screen-lock credential. Do not cache an old PIN, pattern or password.
- Device credential removal, Keystore key invalidation, biometric enrollment changes and authentication failures must be handled explicitly and fail safely without silently destroying or resetting property data.
- App screen lock is an app-entry/session control. Database encryption and database-key protection remain independent storage-security requirements; a screen-lock prompt alone does not make browser storage encrypted.

### Cloud provider authorization and backup

- Cloud backup is optional. Local PMS operation and local encrypted backup/restore must remain available without any cloud account.
- Google Sign-In authenticates the Aurelia owner; it does **not** by itself grant Google Drive access.
- After successful Google Sign-In and owner/property authorization, show an Aurelia explanation screen asking whether the user wants to connect an available supported cloud provider for backup. The user can choose **Allow** or **Deny**.
- **Allow** starts the selected provider's genuine OAuth/authorization flow and requests only the minimum required scopes. The provider is considered connected only after authorization succeeds and is verified.
- **Deny** completes sign-in and opens the PMS without cloud backup. Do not repeatedly show the prompt after a recorded denial; let the user change the choice in Settings.
- Provide provider connection, disconnection, status and backup controls under **Settings → Backup & Storage**. A user can connect a provider later, switch providers, or disconnect one. Revoking/disconnecting cloud access must not delete local PMS data.
- Do not claim Android can enumerate every cloud account, infer every provider's entitlements, or detect arbitrary cloud access. Provider availability is provider-specific and must be established through supported SDKs/account authorization or an explicit user selection.
- Implement cloud providers behind a provider-neutral adapter contract (for example: availability/connection initiation, OAuth callback, account identity, capability reporting, upload, list, download, delete/retention where supported, revoke/disconnect). Keep provider tokens in secure native storage; never expose refresh tokens or client secrets to WebView JavaScript, browser storage, logs or APK resources.
- Google Drive, Microsoft OneDrive and Dropbox may be evaluated as separate provider adapters. Do not claim any provider is supported until its adapter, authorization, security review and end-to-end tests are complete. The system must support a provider being unavailable, disconnected, revoked or temporarily offline without blocking local PMS use.
- Before upload, create an authenticated encrypted backup archive. Verify upload completion and the stored object before reporting backup success. Never upload plaintext property backups.
- Restore must validate authentication/integrity, schema and compatibility; preserve a restore point; stage and verify the restored data, including financial totals; and commit only after verification. A failed restore must leave the existing database intact.
- Automatic backup must not be described as guaranteed while the app is stopped unless a qualified native background execution design and device tests support that guarantee.

### Required product flows

1. **First launch:** choose Local Mode or Google Sign-In.
2. **Google path:** select Google account → Firebase authentication → owner/property authorization → Aurelia cloud-provider Allow/Deny explanation → provider-specific authorization if allowed → open PMS.
3. **Local path:** initialize or unlock the local property → open the same PMS engine without Google or cloud authorization.
4. **Later cloud changes:** Settings → Backup & Storage → connect, switch or disconnect a supported provider.
5. **Later account linking:** Settings → Account → Connect Google Account; authenticate and authorize the existing local property without changing its property ID or replacing its records.

### Implementation and release gates

These decisions are not evidence that the features are already implemented. Before release, verify on supported physical Android devices:
- Offline Local Mode creation, restart and continued operation.
- Canonical SQLCipher-backed live reads/writes and safe legacy-data migration/rollback.
- Native screen-lock prompt, process-kill/relaunch behavior, temporary background behavior and device-credential-change failure cases.
- Google Credential Manager, Firebase token validation and owner/property authorization, including unauthorized-account denial.
- Google Drive consent Allow/Deny, later connection, revocation and reconnection.
- Each additional cloud provider's independent authorization and adapter contract.
- Encrypted backup upload, negative integrity cases, restore staging, financial reconciliation and rollback.

Until these gates pass, describe the relevant capability as planned or in progress, not production-ready.

### Cloud consent and Google Drive backup location — final product decision

This section supersedes any earlier wording in this README that suggests showing a multi-provider picker during Google Sign-In.

- After Google Sign-In and owner/property authorization, show one Aurelia Google Drive consent explanation with **Allow** and **Deny**.
- **Allow** starts Google's actual Drive authorization flow. **Deny** continues into the PMS without cloud backup.
- Do not show a cloud-provider chooser during login. Do not automatically connect another cloud provider.
- If the user denies or skips Drive authorization, they can connect Google Drive later under **Settings → Backup & Storage**. Cloud connection and management remain in Settings.
- Google Sign-In and Google Drive authorization remain separate grants. Signing in does not itself authorize Drive.
- The recommended backup destination is a user-visible folder in the signed-in user's Drive: **My Drive/Aurelia PMS Backups/[Property Name]/**. Aurelia creates and manages its own folder and backup files there.
- Prefer the narrow Google Drive drive.file scope for files created by Aurelia (and files explicitly opened/shared with Aurelia through supported flows). Do not request broad full-Drive access merely to manage Aurelia's own backup folder.
- Do not use the hidden appDataFolder as the default destination for the primary owner-facing backup archive: it is not visible in Drive's normal UI and is intended for app-specific data. It may be considered separately for internal app metadata, not as a substitute for a visible owner-managed backup location.
- Each backup is a versioned, authenticated encrypted archive. Encrypt locally before upload; never upload plaintext PMS data, database keys, PINs, recovery secrets or provider tokens.
- Maintain a backup manifest containing only the necessary metadata (for example schema version, property identifier, backup identifier, creation time, archive size and integrity/authentication metadata). Do not expose guest or financial details in filenames.
- Keep multiple verified restore points with a documented retention policy. Upload to a temporary/new version, verify the stored object, then mark that version as successful. Never overwrite the only known-good backup before a new upload is verified.
- Settings must show provider connection status, destination folder, last successful backup, backup history, manual backup, restore and disconnect actions. Disconnecting Drive must not delete local data.
- Restore must authenticate/decrypt and validate the archive, preserve a local restore point, stage and verify the restored database and financial totals, and only then commit. A failed restore must leave current data intact.
- The user-visible folder can be deleted or modified by its owner. Aurelia must detect missing or inaccessible backup files and report the condition; it must not claim a backup exists merely because a previous upload once succeeded.
- Cloud backup is optional. Local PMS operation and local encrypted export/restore remain available when Drive is denied, disconnected, unavailable or out of quota.

### Google Drive application-data policy gate — clarification

The product preference is to use Google's hidden `appDataFolder` for private, app-managed data if the proposed use is permitted. Google documents that this space is hidden from the Drive UI, accessible only to the creating app, and removable by the user; it is intended for application-specific data such as configuration files. It is not a user-browsable backup folder.

**Do not implement or release Aurelia PMS full-property backup/restore through the Google Drive API solely on the assumption that the `drive.appdata` scope permits it.** Google's Drive API Terms and Workspace user-data/developer policy explicitly restrict backup of user or app content from a developer's app to Drive without Google's express prior written consent. This policy issue is separate from OAuth scope sensitivity or OAuth app verification. Obtain and retain authoritative written approval from Google for Aurelia's exact PMS backup/restore use case before enabling that Drive API workflow. Do not treat a non-sensitive scope, a successful OAuth consent, a forum post, or the hidden nature of `appDataFolder` as policy approval.

Until written approval is obtained:
- Keep Google Sign-In independent and available.
- Keep cloud backup disconnected/disabled; do not upload PMS backups to Drive through the Drive API.
- Continue supporting local encrypted export, restore and device-to-device transfer mechanisms that do not depend on Drive API.
- Evaluate an independently hosted Aurelia backup service or another provider only after reviewing that provider's terms, privacy, security, data residency and operational requirements.
- If Google approves the use case in writing, use the minimum approved scope and re-check the current Google policy and implementation constraints before enabling it.
