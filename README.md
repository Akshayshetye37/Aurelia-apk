# Aurelia PMS

Aurelia PMS is the property-management application maintained in this repository.

## Project location

- **Repository:** https://github.com/Akshayshetye37/Aurelia-apk
- **Maintained branch:** `main`
- **Application entry point:** `index.html`
- **Android packaging:** Capacitor configuration and the maintained Android templates/build scripts in this repository.

## Payment security boundary

**Aurelia UPI is the only enabled payment collection method in Aurelia PMS.**

All other payment rails and payment-provider gateway integrations are disabled in the main application:

- Razorpay, Cashfree, PayU, PhonePe, Paytm, JioPay and CCAvenue integrations are not enabled in PMS.
- Card, bank-transfer and third-party mobile-money choices are not offered in the PMS payment interface.
- Provider selection, gateway checkout, gateway credentials, provider SDKs and provider webhook processing must not be added to the PMS main branch.
- Payment collection controls fail closed: the UI exposes only Aurelia UPI and the application-side policy rejects non-UPI method selections.
- The provider-integration branches are historical/development branches, not the enabled payment configuration for `main`. Do not merge them into `main` without an explicit, reviewed reactivation change.

This is a reversible application-level block, not deletion of historical branch data. To reactivate a provider in the future, make a deliberate source change, security review and end-to-end qualification first. Do not activate a provider merely by changing a saved preference or local setting.

## Payment accounting

Booking folios, payment history, guest balances, cancellation records and accounting journals are PMS business records and are retained. Disabling provider gateways must not erase or rewrite historical payment records. Only the payment collection method is restricted.

A UPI intent/QR is a payment request, not independent proof of settlement. Staff must verify receipt in the receiving UPI/bank account before recording a payment as received.

## Run locally

Open `index.html` in a modern browser for an initial inspection. Android-specific features require a compatible Capacitor/native wrapper and its implemented bridge.

## Security and release status

This repository is a source project, not a declaration of production readiness. Review [docs/SECURITY.md](docs/SECURITY.md), verify the Android build and test on supported physical devices before release. Do not place provider secrets in browser storage, source files, APK resources or client-side configuration.

## Payment policy verification

The main application must satisfy these checks before release:

1. Only the Aurelia UPI payment choice is visible in collection flows.
2. Non-UPI method submissions are rejected by application logic.
3. Provider gateway configuration and checkout interfaces are absent from the PMS main branch.
4. Existing folio and accounting records remain intact.
