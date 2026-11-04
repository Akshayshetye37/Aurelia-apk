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

The cloud credential, validation, activation and checkout routes currently allow only Razorpay and Cashfree, and `src/providers/factory.mjs` registers only those two adapters. PayU and PhonePe source modules are incomplete prototypes (PayU refund operations deliberately fail closed); JioPay has an unqualified module but is not registered or routed; Paytm and CCAvenue are not implemented. None of the seven providers is production-ready. Do not expand the allowlist merely because a source file exists. Each provider must pass the shared adapter contract, server-route tests, raw-body webhook verification, refund lifecycle, authoritative status/reconciliation, merchant sandbox/UAT and operational acceptance.

See [Hybrid Payment Architecture](../docs/HYBRID_PAYMENT_ARCHITECTURE.md) and [Provider Integration Status](../docs/PROVIDER_INTEGRATION_STATUS.md).

## Financial safety

- Never expose merchant secrets to Android, JavaScript, logs, analytics or source control.
- Verify provider status independently; client callbacks are untrusted hints.
- Persist idempotency identities and immutable provider references before dispatch.
- Treat network timeouts as ambiguous and reconcile before retrying.
- Capture and folio settlement are separate states. Use a durable outbox/saga if the payment database and PMS accounting database differ.
- Refunds are separate operations and require provider-confirmed status before PMS reversal posting.
- Keep live collection OFF until every release gate has an auditable pass.

## Tenant payment control plane

The cloud runtime exposes authenticated owner/admin endpoints:

- `GET /v1/admin/payment-controls`
- `PATCH /v1/admin/payment-controls` with `{ "changes": { "test_collection": false }, "reason": "..." }`

The tenant is derived from the verified Firebase membership. Updates require verified email, recent MFA, owner/admin membership and a non-empty reason. Each update is committed with an audit record in the tenant-scoped `paymentControls/{tenantId}/audit` subcollection.

Every financial route reads current control state from Firestore. A missing document, invalid schema or Firestore failure is a deny. Test collection/order/activation requires `test_collection`; live routes require `live_collection` and are additionally rejected by a separate production-readiness gate. The reconciliation worker is gated by `automatic_settlement`.

Turning a capability ON also requires a current independent owner approval at `paymentControlApprovals/{tenantId}/controls/{control}`, with the control-specific evidence list documented in `../docs/CENTRAL_PAYMENT_CONTROL_PLANE.md`. The control API cannot turn `emergency_stop` OFF. Do not manually create approval records to bypass evidence review.

Webhook processing may persist provider verification evidence only. It does not create a settlement authorization or post a folio. Local PMS posting remains separately hard-locked until a signed, short-lived policy lease is enforced by the trusted native boundary.


## Provider implementation files and current boundary

- `src/providers/adapter-contract.mjs` — common provider interface and capability assertion.
- `src/providers/factory.mjs` — executable registry; currently Razorpay and Cashfree only.
- `src/providers/razorpay.mjs`, `src/providers/cashfree.mjs` — registered adapters; still not complete PMS financial pipelines.
- `src/providers/payu-adapter.mjs`, `src/providers/phonepe-adapter.mjs` — prototypes, not enabled.
- `src/providers/jiopay.mjs` — newly added module, not factory-registered or route-enabled; its contract still requires merchant sandbox confirmation.
- Paytm and CCAvenue adapter modules are not present.

The Android project package and actual Capacitor `MainActivity` path must be inspected from the Gradle source tree before adding a native payment plugin. Do not copy example package names or register a plugin against an unverified path. A generic Android URL intent is not equivalent to a production payment bridge.
