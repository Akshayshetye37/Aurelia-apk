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

The native SQLCipher repository foundation exists but is **not yet the canonical application store**. The previous PIN/recovery-key unlock implementation conflicts with the final product decision and must not be presented as approved: Aurelia will not ask users to create or enter a separate database PIN, recovery PIN, recovery passphrase or user-held recovery key. The approved local unlock design is Google account authentication (where Google Mode is used), followed by Android's native device-credential authentication (PIN, pattern or password, with supported biometric authentication) to authorize an Android Keystore-protected database key. Google Sign-In does not itself unlock a device-bound key. This replacement design is not yet implemented or device-qualified, and existing encrypted data must never be deleted or re-keyed as a shortcut. The HTML application still uses browser-side persistence; do not claim SQLCipher is canonical until live business reads/writes, transactional migration, rollback and physical-device tests pass. R8 does not protect WebView JavaScript; production JavaScript minification/obfuscation and signed offline licensing also remain outstanding.

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

- The optional app-entry **Use Screen Lock** control is a separate UI requirement and is not wired by this native database-key change. The SQLCipher database itself requires Android device authentication at each new app process.
- When enabled, Aurelia uses Android's native device-credential authentication prompt (PIN, pattern or password, with supported biometric options where configured). Aurelia does not create, store or compare a separate copy of the device passcode.
- Authenticate when a new Aurelia app process starts after the previous process was killed while in the background.
- After one successful authentication, keep the app unlocked for the lifetime of that process. Do not prompt again for ordinary navigation, temporary backgrounding, notification-shade use, app switching or activity recreation while the process remains alive.
- A process restart requires authentication again when the feature is enabled.
- Use the device's currently configured screen-lock credential. Do not cache an old PIN, pattern or password.
- Device credential removal, Keystore key invalidation, biometric enrollment changes and authentication failures must be handled explicitly and fail safely without silently destroying or resetting property data.
- App screen lock is an app-entry/session control. Database encryption and database-key protection remain independent storage-security requirements; a screen-lock prompt alone does not make browser storage encrypted.

### Native SQLCipher key and workspace authority

- The Android native PMS path uses a random 256-bit SQLCipher DEK. The DEK is wrapped by an AES-256-GCM key held in Android Keystore and configured for per-use authentication with `BIOMETRIC_STRONG | DEVICE_CREDENTIAL`.
- The native unlock prompt uses AndroidX `BiometricPrompt`; it accepts the current Android device PIN, pattern or password and supported strong biometrics. Aurelia does not create or store an application PIN, passphrase, OTP or user-held recovery key.
- This auth-per-use CryptoObject combination requires Android 11 (API 30) or later. Unsupported Android versions and devices without a secure screen lock fail closed rather than falling back to an app-managed secret.
- The DEK is held only in native process memory after authentication. The SQLCipher repository closes on bridge/activity destruction, but the process-scoped DEK remains available across ordinary activity recreation; process death clears it and requires a new Android authentication. Explicit `lockDatabase()` clears it sooner.
- Existing legacy PIN/recovery envelopes or an existing SQLCipher database without the v2 device-auth envelope are detected and are not overwritten. They remain a migration/recovery gate; the new key is never silently substituted for an existing database key.
- The live native workspace is stored as a versioned `workspace/current` entity in SQLCipher. First migration stores the exact source snapshot and SHA-256 in the native legacy-backup and migration-snapshot tables, writes the canonical workspace, verifies read-back and SQLite/SQLCipher integrity, and promotes authority in one transaction. The browser source is retained; it is not deleted after migration.
- After canonical cutover, all PMS saves go to SQLCipher with optimistic version checks and exact read-back verification. Browser storage fallback is disabled. If the native workspace disappears after a previous cutover, the app blocks automatic re-import from a potentially stale browser copy.

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

### Cloud backup and Google Drive access — superseded by SAF decision

- Google Sign-In authenticates the Aurelia owner; it does not grant Drive access.
- Aurelia's approved zero-server backup direction is Android Storage Access Framework (SAF), using a user-selected Google Drive folder where the installed Drive DocumentsProvider is available. This is not Drive REST API access and does not request broad Drive OAuth scopes.
- After Google Sign-In and owner/property authorization, show one first-time Aurelia explanation asking permission to search for an existing backup in a folder the user selects. Deny is remembered and must not trigger another automatic popup or dashboard warning. The user can later initiate discovery or configure backup under Settings → Backup & Storage.
- Allow launches the Android folder picker. The owner selects the folder; Aurelia persists the URI permission where supported and searches only that selected folder. Never claim to search all of Drive.
- On a new device, the owner signs in, authorizes the property, then selects the backup folder again because SAF URI permissions do not automatically transfer between devices.
- A matching backup is presented with Skip on the left and Restore on the right. Discovery never causes automatic restoration.
- Aurelia creates its own Aurelia Backups / property-specific subfolder after the owner grants access, where provider capabilities permit. It must test read/write access before reporting setup success.
- Encrypt backup archives before writing them. Never write plaintext PMS data, database keys or authentication tokens to the selected folder.
- Keep Android Auto Backup supplementary only; never rely on its quota as the primary PMS backup.
- Do not use Drive REST API or Drive OAuth scopes for PMS backup unless Google has expressly approved the exact app-content backup use case in writing. SAF must not be described as a policy workaround; review Google's current applicable terms for the actual app behavior.
- Cross-device restore remains blocked until the DEK can be recovered securely without a user-held recovery PIN/passphrase/key. Google Sign-In plus the replacement phone's screen lock does not by itself recover a key protected by the original phone's Android Keystore.

### Google Drive application-data policy gate — clarification

The product preference is to use Google's hidden `appDataFolder` for private, app-managed data if the proposed use is permitted. Google documents that this space is hidden from the Drive UI, accessible only to the creating app, and removable by the user; it is intended for application-specific data such as configuration files. It is not a user-browsable backup folder.

**Do not implement or release Aurelia PMS full-property backup/restore through the Google Drive API solely on the assumption that the `drive.appdata` scope permits it.** Google's Drive API Terms and Workspace user-data/developer policy explicitly restrict backup of user or app content from a developer's app to Drive without Google's express prior written consent. This policy issue is separate from OAuth scope sensitivity or OAuth app verification. Obtain and retain authoritative written approval from Google for Aurelia's exact PMS backup/restore use case before enabling that Drive API workflow. Do not treat a non-sensitive scope, a successful OAuth consent, a forum post, or the hidden nature of `appDataFolder` as policy approval.

Until written approval is obtained:
- Keep Google Sign-In independent and available.
- Keep cloud backup disconnected/disabled; do not upload PMS backups to Drive through the Drive API.
- Continue supporting local encrypted export, restore and device-to-device transfer mechanisms that do not depend on Drive API.
- Evaluate an independently hosted Aurelia backup service or another provider only after reviewing that provider's terms, privacy, security, data residency and operational requirements.
- If Google approves the use case in writing, use the minimum approved scope and re-check the current Google policy and implementation constraints before enabling it.

### Backup discovery consent and restore UX — latest decision

This section supersedes earlier backup-login UX wording wherever it conflicts with the decisions below. It defines the intended user experience; it does not claim that SAF backup, key recovery, background scheduling or restore is already implemented or production-qualified.

- After successful Google Sign-In and owner/property authorization, Aurelia shows **one** first-time explanation popup asking whether the user allows Aurelia to look for an existing property backup in a user-selected storage folder.
- The popup has **Deny** on the left and **Allow** on the right.
- **Allow:** launch Android's Storage Access Framework (SAF) folder picker. Where supported, suggest Google Drive as the initial location, but do not assume Android can force a particular provider or folder to open. The owner selects the existing Aurelia backup folder and grants access. Aurelia persists the granted URI permission where supported, then searches only within the selected folder for backups matching the authenticated owner and authorized property.
- SAF folder permission is not Google Drive OAuth and does not grant access to the entire Drive account. Do not use Drive REST API access or broad Drive OAuth scopes as a substitute for this folder-selection flow.
- If a matching, valid backup is found, show a separate restore decision with **Skip** on the left and **Restore** on the right. Do not restore automatically merely because a backup was found.
- **Deny:** remember the user's decision and continue into the PMS. Do not show the discovery popup again automatically, do not show a persistent dashboard warning, and do not interrupt normal PMS operation.
- After denying, the user can initiate discovery or configure/change the backup destination manually at **Settings → Backup & Storage**. Provide a clear **Find Existing Backup** / **Set Up Automatic Backup** action there. The user may change their decision at any time.
- Denial of backup discovery is not consent to create a duplicate property and is not evidence that no backup exists. Do not create or initialize a replacement property until the normal property-selection/creation flow and identity checks are complete.
- If the user allows discovery but no matching backup is found, continue to the normal property setup/selection flow and report that no matching backup was found; do not imply that all of Drive was searched.
- On a replacement device, Google Sign-In and owner/property authorization happen first. Because SAF URI permissions do not automatically transfer to a new device, the user must select the backup folder again before Aurelia can inspect it.
- Validate backup ownership metadata, property identity, archive authentication/integrity, schema compatibility and financial-ledger consistency before offering or completing restore. Never overwrite an initialized property silently. Stage restoration and preserve existing data if validation or restore fails.
- Keep Local Mode available without Google Sign-In. The SAF backup folder is optional; lack of folder permission must never block core local PMS operations.
- Do not introduce a Property Recovery PIN, recovery passphrase or user-held recovery key. A secure encryption-key recovery design that meets this product constraint remains a prerequisite for claiming cross-device encrypted restore; Google Sign-In by itself does not recover a device-bound encryption key.
- Android Auto Backup, if configured, is supplementary only. Do not rely on its 25 MB quota or claim it guarantees a complete PMS backup. SAF backup is a separate user-authorized destination and background execution/provider availability must be tested on supported physical devices.


## Final authentication, device unlock and data-protection decisions — 28 November 2026

This section is the authoritative product decision and supersedes earlier README wording that conflicts with it.

### Authentication policy

- Google Sign-In through Android Credential Manager is the only account-login method in Google Mode.
- Firebase Authentication validates the Google ID token; Aurelia then independently verifies owner/property membership. An authenticated but unauthorized Google account receives no property access and must not silently create a property.
- No Aurelia email/password login, email verification link, email OTP, SMS OTP, verification email/message, separate Aurelia password, recovery PIN, recovery passphrase or user-held recovery key.
- Local Mode remains permanent and available without Google Sign-In. It uses the same PMS business rules and must not be a restricted demo.
- Google identity, Aurelia owner identity, tenant/property identity and device/installation identity remain separate.

### Device screen-lock authorization

- After Google authentication and owner/property authorization, a device with an existing local encrypted property must request Android's genuine native device credential prompt before opening the database.
- Accept the device's configured PIN, pattern or password and supported biometric authenticators through AndroidX BiometricPrompt / Android Keystore. Do not create or store an Aurelia-specific passcode.
- Use an authentication-bound Android Keystore key to protect access to the random 256-bit SQLCipher DEK. The screen-lock credential is an authorization factor handled by Android; it is not the DEK and must never be copied into Aurelia storage.
- After successful authentication, make the database available only for the lifetime of the authenticated app process/session. Lock and clear in-memory key material on process termination and explicit lock. Do not re-prompt for ordinary navigation or temporary app switching while the same authorized process remains alive.
- If device authentication is unavailable, cancelled, fails, or the Keystore key is invalidated, keep the database locked and preserve the encrypted database. Never generate a replacement DEK for an existing database.
- Google Sign-In proves account control; it does not prove that a device belongs exclusively to that owner and does not, by itself, unlock a device-bound key.

### Storage and secret boundaries

- HTML and JavaScript are presentation/client code only. They must not be the canonical store for guest, booking, folio, payment, identity-document or other property business data.
- The target canonical store is native SQLCipher SQLite, accessed through a narrow validated Capacitor bridge. Browser storage may be used only for non-sensitive UI preferences or a deliberately temporary migration/cache layer; it must not remain the authority for business records after cutover.
- Keep the random 256-bit DEK protected by Android Keystore. Never expose it to WebView JavaScript, localStorage, HTML, logs, crash messages, analytics or exported files.
- Google Drive is an optional encrypted backup destination via the approved SAF user-selected-folder flow. It is not live storage and must never receive plaintext PMS data.
- Keep provider/API secrets out of HTML, JavaScript, APK resources and source control. Use server-side secret management for future backend credentials.
- Production errors shown to users must be generic, actionable and non-sensitive. Never expose stack traces, filesystem paths, SQL statements, tokens, keys, guest details, payment details or raw provider responses in popups. Redact sensitive values from logs and crash diagnostics.
- Keep R8/resource shrinking, release debuggable=false, WebView debugging disabled, restrictive WebView settings, reviewed CSP, dependency pinning and private/restricted repository access. Minification/obfuscation raises reverse-engineering cost but cannot make shipped app logic impossible to inspect.

### Backup and restore UX

- After Google Sign-In and owner/property authorization, show one first-time backup-discovery consent popup with Deny on the left and Allow on the right.
- Allow opens the Android SAF folder picker; Aurelia searches only the folder the user selects.
- Deny is remembered. Do not automatically prompt again and do not show a persistent dashboard warning. The user can later choose Find Existing Backup or Set Up Automatic Backup in Settings → Backup & Storage.
- If a matching valid backup is found, show Skip on the left and Restore on the right. Never restore automatically.
- If no backup is found, proceed to normal property selection/creation without claiming that all Drive storage was searched.
- Validate owner/property binding, archive authentication, schema compatibility, database integrity and financial ledger continuity before restore. Stage restore and preserve current data on failure.
- Android Auto Backup is supplementary only and is not a guaranteed full PMS backup.

### Explicit unresolved security gate: replacement-device key recovery

A Keystore key protected by the original device's screen lock is device-bound. A new phone's Google Sign-In and its own screen lock cannot decrypt the old phone's DEK. SAF transfers encrypted backup files, not Keystore private keys. Therefore cross-device encrypted restore must not be advertised as working until a secure, reviewed key-transfer/recovery design is approved that does not introduce a user-held recovery PIN, passphrase or recovery key. Do not weaken encryption, store the DEK beside the backup, derive it from a Google ID token, or silently create a new DEK to bypass this limitation.

### Implementation status and release gates

The `fix/native-device-auth-sqlcipher-cutover` implementation branch contains the Android device-authenticated DEK path and the SQLCipher canonical workspace read/write and copy-first browser migration path. It is not yet merged into `main` or production-qualified. Existing legacy PIN/recovery envelopes and pre-existing SQLCipher databases are deliberately blocked from automatic key replacement pending a verified migration path. Google Credential Manager/Firebase owner authorization, encrypted SAF backup, cross-device key recovery and physical-device qualification remain separate release gates. Android Java source compilation is verified by the GitHub Actions native compile workflow; physical-device authentication, Keystore invalidation and lifecycle behavior have not been verified. No production-ready claim is permitted before those gates pass.


## Native storage, identity and backup qualification

The current isolated implementation is under review in draft PR #98. Do not treat the following candidate-branch work as merged into main until the PR is approved and merged.

### Implemented on the candidate branch

- Android SQLCipher is the canonical native PMS database after a verified, transactional migration from the existing browser workspace.
- A random 256-bit database DEK is protected by an Android Keystore auth-per-use key and the Android device credential/strong-biometric prompt. The DEK is not exposed to the WebView.
- A one-time migration path exists for legacy databases that still have a usable v1 biometric envelope: it rewraps the same DEK, opens the existing database and verifies integrity before retiring old envelopes.
- PMS domain entities and outbox records are projected from the SQLCipher workspace and synchronized after workspace saves. Financial ledger and audit history are append-only.
- The compatibility workspace remains the UI read model. Direct domain command/read cutover and a single atomic transaction spanning the compatibility workspace and all domain writes are not yet complete.
- Client-side encrypted backup envelopes use a fresh per-backup DEK, chunked AES-256-GCM, property/backup-bound authenticated data and a server-wrapped DEK. Plaintext backup export/restore is blocked.

### Explicitly not yet operational

- Google Credential Manager sign-in, Firebase Authentication and trusted owner/property membership authorization are not yet configured or deployed.
- The Firebase owner-membership provisioning service and Cloud KMS wrap/unwrap service are not deployed. Portable encrypted backup and restore are therefore unavailable until those services exist.
- Existing legacy databases that have only the old PIN/recovery envelope still require the original legacy unlock factor. No replacement key is generated and the old database is not overwritten.
- Physical-device qualification (biometric/device credential, process death, device credential change, restore and Keystore invalidation) is outstanding.
- Full PMS workflow and financial-ledger end-to-end qualification remains outstanding.

See [docs/SECURITY.md](docs/SECURITY.md) and [docs/BACKUP-KEY-RECOVERY-CONTRACT.md](docs/BACKUP-KEY-RECOVERY-CONTRACT.md) for the exact security boundaries and infrastructure contract.

### Candidate-branch verification

The latest candidate commit was verified with Node contract tests, web packaging, dependency audit and Android native Java compilation. These checks do not constitute a signed APK build, physical-device test, deployed Google/Firebase configuration or production backup service.
