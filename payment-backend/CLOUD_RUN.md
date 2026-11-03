# Deploy the Aurelia hybrid payment backend

This is a deployment runbook for the selected backend in `src/server.mjs`. It does not claim the provider adapters or live-payment lifecycle are complete.

## Prerequisites

- A Google Cloud project with billing enabled.
- Cloud Run, Artifact Registry, Firestore and Secret Manager APIs enabled.
- A dedicated Cloud Run runtime service account.
- Firestore initialized in the required region.
- Secret Manager secrets provisioned for the enabled provider credentials.
- A public HTTPS domain/ingress and provider webhook URLs.
- A Firebase Authentication project and configured sign-in/MFA policy.
- Merchant-approved sandbox accounts for provider testing.

## Build and deploy

From `payment-backend/`, build the cloud-specific image:

```bash
gcloud builds submit --tag REGION-docker.pkg.dev/PROJECT_ID/REPOSITORY/aurelia-payment-backend:TAG -f Dockerfile.cloud .
```

Deploy to Cloud Run with a dedicated service identity and public HTTPS ingress:

```bash
gcloud run deploy aurelia-payment-backend \\
  --image REGION-docker.pkg.dev/PROJECT_ID/REPOSITORY/aurelia-payment-backend:TAG \\
  --region REGION \\
  --service-account aurelia-payment-runtime@PROJECT_ID.iam.gserviceaccount.com \\
  --port 8080 \\
  --set-env-vars GOOGLE_CLOUD_PROJECT=PROJECT_ID,AURELIA_HTTPS_TERMINATION=trusted-proxy,AURELIA_TRUST_PROXY_HOPS=1,AURELIA_OWNER_ORIGINS=https://localhost \\
  --no-allow-unauthenticated
```

The command is a template: replace every placeholder and configure an authenticated public ingress/API gateway that allows provider webhook POSTs to the exact webhook routes while enforcing TLS and rate limits. The current server's authentication middleware and webhook routing must be reviewed together before production exposure. Do not enable unauthenticated access to all routes merely to receive webhooks.

Grant the Cloud Run service identity only the required Firestore read/write and Secret Manager access. Use Secret Manager IAM at the narrowest practical scope. Do not create or download service-account JSON keys. Keep the provider secrets out of environment variables where practical; the application already uses Secret Manager for provider credentials.

## Required environment

- `GOOGLE_CLOUD_PROJECT`
- `AURELIA_OWNER_ORIGINS` — exact HTTPS origins only
- `AURELIA_HTTPS_TERMINATION=trusted-proxy`
- `AURELIA_TRUST_PROXY_HOPS=1`
- `PORT=8080` (Cloud Run injects PORT)

The trusted ingress must overwrite forwarded headers and be the only path to the service. Configure webhook URLs in each provider merchant dashboard to the public ingress URL. Never point provider webhooks at a private LAN address or the Android device.

## Before any live activation

The cloud runtime currently whitelists Razorpay and Cashfree only. The other five provider adapters are absent. The cloud Firestore repository, public webhook ingress, refund lifecycle, native client authentication and canonical PMS folio projector still require implementation and tests. Live collection must remain OFF until the release gates in [the hybrid architecture](../docs/HYBRID_PAYMENT_ARCHITECTURE.md) pass.