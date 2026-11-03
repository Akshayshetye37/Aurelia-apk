# Security and privacy review

These notes reflect a preliminary static review of the supplied `index.html`; they are not a security audit.

## Address before production

1. **Third-party UPI QR transmission has been removed.** The PMS now creates the UPI intent locally and offers an Open UPI app action; QR image display is temporarily disabled until an on-device QR encoder is integrated. Do not reintroduce remote QR image endpoints that receive payee, amount, guest or transaction metadata.
2. **Booking API credentials are handled in client-side settings.** A browser-delivered HTML app cannot keep a shared API secret confidential. Do not store production bearer tokens in local storage or expose privileged API credentials in frontend code. Use a backend proxy with appropriate authentication and authorization.
3. **Guest information is sensitive.** Guest names, contact details, ID-document data, occupancy details, invoices, and balances need access controls, retention rules, backups, and secure transport/storage appropriate to the deployment.
4. **External dependencies require network access.** The app references CDN-hosted libraries and remote services. Pin and review dependencies, consider self-hosting critical libraries, and establish a dependency-update process.
5. **Defaults and sample data need review.** Confirm property name, phone, UPI ID, currency, room rates, restaurant menu, and all sample records before operational use.

## Validation status

- The current HTML source includes closing document tags, but a static source check does not validate browser runtime behavior, Android WebView integration, payment correctness, authorization, or backend connectivity.
- GitHub Actions runs payment/parser/evidence-store regression tests before attempting the Android debug build. These unit tests do not replace browser, device, security, or end-to-end testing.
- The IndexedDB evidence journal is local to one installation and is not suitable as the production ledger or as the source of truth across devices.
- Automatic folio settlement is explicitly disabled. Keep it disabled until a trusted backend provides atomic ledger writes, durable idempotency, authorization, audit history, and tested failure recovery.

## Recommended release gate

Do not process real guest data or payments until the source is complete, secrets are moved out of the client, third-party data flows are reviewed, and the browser plus Android integration has been tested end to end.
