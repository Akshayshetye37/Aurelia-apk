# Payment backend deployment runbook

This service is **not deployed by this repository**. The workflow validates tests and builds a container; it does not provision cloud resources or make a public endpoint.

## Runtime requirements

- Node.js 20 or the supplied Docker image.
- A Google Cloud project with Firestore Native mode and Secret Manager enabled.
- A dedicated runtime service account with least-privilege access to Firestore and Secret Manager. Do not use a downloaded service-account JSON key.
- HTTPS ingress (Cloud Run is the reference target). The container must not be exposed directly around the HTTPS ingress.
- Exact browser origins in AURELIA_OWNER_ORIGINS, comma-separated, with scheme and host only. Do not use wildcard origins.
- GOOGLE_CLOUD_PROJECT set to the project that owns the Firestore database and secrets.
- AURELIA_TRUST_PROXY_HOPS=1 only when exactly one trusted ingress proxy overwrites X-Forwarded-Proto. Otherwise leave it unset.
- PORT supplied by the platform (defaults to 8080).

## Cloud Run deployment outline

1. Create/select the Google Cloud project and enable Cloud Run, Artifact Registry, Firestore and Secret Manager APIs.
2. Create a dedicated runtime service account. Grant only the required Firestore data access and Secret Manager secret access roles. Do not grant project Owner/Editor.
3. Create the Firestore database in Native mode and deploy reviewed Security Rules. Mobile clients must not write payment membership, intent, order, idempotency, webhook inbox or folio-lock collections.
4. Build and push the image from this directory. Configure Cloud Run with the runtime service account, GOOGLE_CLOUD_PROJECT, exact AURELIA_OWNER_ORIGINS, AURELIA_TRUST_PROXY_HOPS=1, and a platform-managed HTTPS URL.
5. Require HTTPS ingress, disable unauthenticated administrative access at the application layer (admin routes additionally require Firebase ID token, verified email, MFA and active tenant membership), and restrict direct container ingress.
6. Configure Firebase Authentication MFA and create membership documents using a separate trusted provisioning process. A client must never self-assign tenant or owner role.
7. Call GET /healthz over the final HTTPS URL. A successful response proves only that the process is responding; it does not prove Firestore permissions, Secret Manager access, merchant credentials, webhooks or payment flows.
8. Before configuring the endpoint in PMS, implement and verify the missing payment-intent API, Cashfree service routes, reconciliation, folio ledger settlement, and authenticated backend identity. Do not treat the current generic health check as a trust/identity handshake.
9. Use Razorpay test credentials and real sandbox checkout/webhook events. Keep live activation disabled until all acceptance gates in README.md pass.

## Environment variables

| Variable | Required | Description |
|---|---:|---|
| GOOGLE_CLOUD_PROJECT | Yes | GCP project ID |
| AURELIA_OWNER_ORIGINS | Yes | Exact allowed HTTPS origins, comma-separated |
| AURELIA_TRUST_PROXY_HOPS | Conditional | Set to 1 only behind one trusted proxy |
| PORT | No | HTTP port inside the container; defaults to 8080 |

The service uses Application Default Credentials from its attached runtime identity. Never commit credentials or put them in container build arguments.

## Health semantics and operational checks

- GET /healthz: liveness only. It does not query Firestore or Secret Manager.
- A green health check must never enable gateway collection or owner administration by itself.
- Monitor 5xx responses, provider API failures, webhook verification failures, unresolved UNKNOWN intents, Firestore contention and Secret Manager access errors.
- Configure platform logs/metrics/alerts and tested backups before production use.
- Rotate merchant API and webhook secrets through the owner-admin flow after that flow is security-reviewed. Never print credentials or request bodies in logs.

## Current hard blockers

The current server is a limited Razorpay onboarding/test-order service. It does not yet expose the customer payment-intent API, integrate the PMS folio schema, settle the folio ledger exactly once, run reconciliation, wire Cashfree routes, or connect Pay Bridge. Therefore deployment and a passing /healthz check do **not** make live payments safe or the PMS payment integration production-ready.
