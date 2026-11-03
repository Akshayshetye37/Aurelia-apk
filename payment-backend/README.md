# Aurelia Payment Backend

**Selected runtime:** `src/server.mjs` — hybrid production backend foundation (Firebase Admin, Firestore, Google Secret Manager). **Status: prototype; not approved for live collection.**

The Android application is an offline-first PMS client. This backend is the only intended production payment authority: it owns merchant credentials, provider API calls, public webhook ingress, authoritative verification, refund processing and reconciliation. Deploy it only behind public HTTPS ingress with managed identity, Firestore, Secret Manager, monitoring and least-privilege IAM.

The separate `src/local-server.mjs` and Docker/LAN setup are development/administration tools only. A private LAN endpoint behind NAT is not a production provider-webhook receiver and must not be represented as the hybrid production backend.

## Runtime setup

Node.js 22 or later is required. Configure a Google Cloud project, enable Firestore and Secret Manager, grant the runtime service identity least-privilege access, configure exact HTTPS browser origins, and deploy behind a public TLS ingress. Use Application Default Credentials/workload identity; never ship service-account JSON keys.

```bash
npm install
npm run start:cloud
npm test
```

Required environment: `GOOGLE_CLOUD_PROJECT`, `AURELIA_OWNER_ORIGINS`, `AURELIA_HTTPS_TERMINATION=trusted-proxy`, and `AURELIA_TRUST_PROXY_HOPS=1`. Configure the ingress to overwrite forwarded-protocol headers and make the service unreachable except through that ingress.

## Implemented provider coverage

The current cloud repository and provider factory allow only Razorpay and Cashfree. The other providers (PayU, PhonePe, Paytm, JioPay and CCAvenue) are not implemented in the cloud runtime. Do not mark them configured, validated, active or live-capable until their adapters, API contract tests, merchant sandbox/UAT and webhook/refund/reconciliation flows are complete.

See [Hybrid Payment Architecture](../docs/HYBRID_PAYMENT_ARCHITECTURE.md) and [Provider Integration Status](../docs/PROVIDER_INTEGRATION_STATUS.md).

## Financial safety

- Never expose merchant secrets to Android, JavaScript, logs, analytics or source control.
- Verify provider status independently; client callbacks are untrusted hints.
- Persist idempotency identities and immutable provider references before dispatch.
- Treat network timeouts as ambiguous and reconcile before retrying.
- Capture and folio settlement are separate states. Use a durable outbox/saga if the payment database and PMS accounting database differ.
- Refunds are separate operations and require provider-confirmed status before PMS reversal posting.
- Keep live collection OFF until every release gate has an auditable pass.
