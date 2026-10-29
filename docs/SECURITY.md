# Security and privacy review

These notes reflect a preliminary static review of the supplied `index.html`; they are not a security audit.

## Address before production

1. **UPI QR generation uses a third-party endpoint.** The QR image URL includes an encoded UPI payment URI. That URI can contain the payee, amount, guest-related text, and transaction reference. Prefer generating QR images locally or in a trusted backend, and avoid sending guest/payment details to third-party URL services.
2. **Booking API credentials are handled in client-side settings.** A browser-delivered HTML app cannot keep a shared API secret confidential. Do not store production bearer tokens in local storage or expose privileged API credentials in frontend code. Use a backend proxy with appropriate authentication and authorization.
3. **Guest information is sensitive.** Guest names, contact details, ID-document data, occupancy details, invoices, and balances need access controls, retention rules, backups, and secure transport/storage appropriate to the deployment.
4. **External dependencies require network access.** The app references CDN-hosted libraries and remote services. Pin and review dependencies, consider self-hosting critical libraries, and establish a dependency-update process.
5. **Defaults and sample data need review.** Confirm property name, phone, UPI ID, currency, room rates, restaurant menu, and all sample records before operational use.

## Validation status

- Inline JavaScript blocks previously passed Node.js syntax checks.
- That check does not validate browser runtime behavior, HTML completeness, Android WebView integration, payment correctness, authorization, or backend connectivity.
- The supplied file currently appears truncated at the end: it finishes after a CSS `</style>` block without closing document tags. Restore/complete the source and rerun HTML/JavaScript checks before release.

## Recommended release gate

Do not process real guest data or payments until the source is complete, secrets are moved out of the client, third-party data flows are reviewed, and the browser plus Android integration has been tested end to end.
