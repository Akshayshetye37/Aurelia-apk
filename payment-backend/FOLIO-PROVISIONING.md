# Authoritative folio provisioning contract

Payment checkout is fail-closed unless the PMS folio has been provisioned into Firestore by a trusted server-side integration. The public payment-intent API does not accept tenant IDs, booking IDs, guest IDs, balances, or due amounts from the browser.

## Required Firestore document

Collection: paymentFolios. Document ID: lowercase hexadecimal SHA-256 of UTF-8 <tenantId>:<folioId>.

Required fields:
- tenantId: authenticated tenant membership tenant ID.
- folioId: PMS folio identifier.
- bookingId: authoritative PMS booking identifier.
- status: open only for payable folios.
- currency: INR.
- balanceMinor: non-negative safe integer paise balance, maintained by trusted sync.
- revision: monotonically increasing source revision.

Only a trusted backend/service account may write these documents. Never expose client write permissions for paymentFolios, paymentIntents, paymentFolioLocks, paymentIntentIdempotency, paymentProviderOrders, or webhook inbox collections. Do not create these documents directly from untrusted PMS browser payloads.

## Current API

- POST /v1/payments/intents: Firebase ID token, verified email, MFA second-factor claim, recent authentication (10 minutes), active tenant membership. Requires an idempotency key. Currently Razorpay test only.
- GET /v1/payments/intents/:intentId: returns the authenticated tenant's stored intent state. This is not a provider status pull and must not be used as proof of capture.

A provider order is not a captured payment. The API deliberately does not settle the PMS folio. A trusted PMS sync/provisioner, provider status reconciliation, verified webhook-to-intent mapping, and exactly-once ledger posting remain required before any payment can be marked paid in the PMS. The folio lock remains held; no client endpoint releases it.

## Activation boundary

Live environment and Cashfree are intentionally rejected by the customer checkout API until their credential onboarding, webhook mapping, status reconciliation, and folio ledger settlement have separate verified acceptance tests. /healthz remains liveness only.
