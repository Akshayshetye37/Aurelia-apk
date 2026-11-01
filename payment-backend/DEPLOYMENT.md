# Payment backend deployment runbook

This service is **not deployed by this repository**. The workflow validates tests and builds a container; it does not provision cloud resources or make a public endpoint.

## Runtime requirements

- Node.js 20 or the supplied Docker image.
- A Google Cloud project with Firestore Native mode and Secret Manager enabled.
- A dedicated runtime service account with least-privilege access to Firestore and Secret Manager. Do not use a downloaded service-account JSON key.
- HTTPS ingress (Cloud Run is the reference target). The container must not be exposed directly around the HTTPS ingress.
- Exact browser origins in AURELIA_OWNER_ORIGINS, comma-separated, with scheme and host only. Do not use wildcard origins.
- GOOGLE_CLOUD_PROJECT set to the project that owns the Firestore database and secrets.
- AURELIA_HTTPS_TERMINATION=trusted-proxy and AURELIA_TRUST_PROXY_HOPS=1 are mandatory. The service fails startup if either is missing. Set them only behind exactly one trusted HTTPS ingress proxy that overwrites X-Forwarded-Proto.
- PORT supplied by the platform (defaults to 8080).

## Cloud Run deployment outline

1. Create/select the Google Cloud project and enable Cloud Run, Artifact Registry, Firestore and Secret Manager APIs.
2. Create a dedicated runtime service account. Grant only the required Firestore data access and Secret Manager secret access roles. Do not grant project Owner/Editor.
3. Create the Firestore database in Native mode and deploy reviewed Security Rules. Mobile clients must not write payment membership, intent, order, idempotency, webhook inbox or folio-lock collections.
4. Build and push the image from this directory. Configure Cloud Run with the runtime service account, GOOGLE_CLOUD_PROJECT, exact AURELIA_OWNER_ORIGINS, AURELIA_HTTPS_TERMINATION=trusted-proxy, AURELIA_TRUST_PROXY_HOPS=1, and a platform-managed HTTPS load balancer URL. Configure Cloud Run ingress as internal-and-cloud-load-balancing, and disable the default run.app URL.
5. Require HTTPS ingress, disable unauthenticated administrative access at the application layer (admin routes additionally require Firebase ID token, verified email, MFA and active tenant membership), and restrict direct container ingress.
6. Configure Firebase Authentication MFA and create membership documents using a separate trusted provisioning process. A client must never self-assign tenant or owner role.
7. Call GET /healthz for process liveness and GET /readyz over the final HTTPS URL. `/readyz` must report both Firestore and Secret Manager checks as true; this verifies runtime dependency access only, not merchant credentials, owner authentication, webhooks or payment flows.
8. Before enabling remote payment in PMS, complete the owner-controlled endpoint trust handshake and verify the backend identity. The PMS endpoint configuration UI and authenticated handshake are not implemented; do not point the installed PMS at an arbitrary URL.
9. Verify the customer intent route against the real PMS folio schema, run Firestore Emulator integration tests, implement reconciliation and exactly-once folio ledger posting, then test Razorpay and Cashfree with merchant sandbox credentials and real signed webhook events. Keep live activation disabled until every acceptance gate in README.md passes.

## Environment variables

| Variable | Required | Description |
|---|---:|---|
| GOOGLE_CLOUD_PROJECT | Yes | GCP project ID |
| AURELIA_OWNER_ORIGINS | Yes | Exact allowed HTTPS origins, comma-separated |
| AURELIA_HTTPS_TERMINATION | Yes | Must be trusted-proxy when behind the managed HTTPS load balancer |
| AURELIA_TRUST_PROXY_HOPS | Yes | Must be 1 behind exactly one trusted ingress proxy |
| PORT | No | HTTP port inside the container; defaults to 8080 |

The service uses Application Default Credentials from its attached runtime identity. Never commit credentials or put them in container build arguments.

## Health semantics and operational checks

- GET /healthz: liveness only. It does not query Firestore or Secret Manager.
- GET /readyz: checks Firestore read access and access to the Terraform-provisioned `aurelia-payment-backend-health` Secret Manager resource. It returns 503 if either dependency is unavailable.
- A successful liveness or readiness check must never enable gateway collection or owner administration by itself.
- Monitor 5xx responses, provider API failures, webhook verification failures, unresolved UNKNOWN intents, Firestore contention and Secret Manager access errors.
- Configure platform logs/metrics/alerts and tested backups before production use.
- Rotate merchant API and webhook secrets through the owner-admin flow after that flow is security-reviewed. Never print credentials or request bodies in logs.

## Current hard blockers

The current server exposes provider-neutral Razorpay and Cashfree onboarding, credential validation, test-order, webhook and customer payment-intent routes. The service remains **not production-ready**: actual PMS folio/ledger integration, exactly-once accounting, reconciliation, authenticated PMS endpoint trust, complete Cashfree/Razorpay merchant sandbox acceptance, refund lifecycle, Firestore Emulator verification and Pay Bridge execution are outstanding. Deployment and a passing `/healthz` check do **not** make live payments safe.
