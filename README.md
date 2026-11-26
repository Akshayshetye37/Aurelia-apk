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

The Aurelia UPI collection, notification evidence, FIFO queue, manual reconciliation, refund register and local QR implementation are documented in [docs/AURELIA_UPI.md](docs/AURELIA_UPI.md). The Sovereign PMS shell uses Overview, Chambers, Stays, Dining, Vault and Aurelia UPI as primary navigation. The supplied HTML is used as the visual reference; its static demo data and simulated payment confirmation are not used as production settlement logic.

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

Open `index.html` in a modern browser for an initial inspection. Android-specific features require a compatible Capacitor/native wrapper and its implemented bridge.

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
