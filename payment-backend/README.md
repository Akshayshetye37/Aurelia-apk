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

## Runtime reliability and infrastructure controls

- Express 4 route handlers and promise-returning middleware are wrapped so rejected asynchronous work reaches the final error handler. Parser failures receive bounded 4xx responses; unexpected application or infrastructure failures receive a generic 500 response without exposing internal exception details.
- Cloud Run shutdown handles `SIGTERM` and `SIGINT`, stops accepting new connections, drains in-flight requests for a bounded period, then closes Firestore and Secret Manager clients.
- The production Cloud Run image runs as the unprivileged `node` user.
- Terraform configures startup and liveness probes against `/healthz`, and a readiness probe against `/readyz` for Firestore and Secret Manager reachability. The two probe paths are non-sensitive and are the only routes exempted from forwarded-HTTPS enforcement.
- Provider credential removal disables every enabled Secret Manager version while retaining the secret resources; the runtime IAM role does not receive project-wide secret deletion permission.
- Payment-intent recovery refuses to overwrite a provider-order binding belonging to another tenant, folio, intent, provider, environment, amount or currency.
- Webhook verification preserves the provider's existing activation state. A routine verified webhook can no longer deactivate a provider.
- Test-order creation requires validated test credentials and persists the exact provider order ID for webhook binding.
- HTTP header and request lifetimes are bounded to 15 and 30 seconds, aligned with the load-balancer request budget.
- The local SQLite driver is a development dependency and is excluded from the Cloud Run runtime image.
- Payment backend CI runs backend tests, builds the Cloud Run image, verifies the image's non-root user, and validates Terraform formatting and configuration.

These controls improve runtime reliability and deployment safety; they do not complete the native settlement bridge, canonical PMS ledger integration, provider merchant certification or live-payment release gates.

## Implemented provider coverage

The provider factory now has seven-operation contract implementations wired for Razorpay, Cashfree, PayU, PhonePe, Paytm and JioPay. CCAvenue remains catalogue-only because the current official public material reviewed does not establish a complete standard checkout/status/refund contract for the merchant product.

All six factory-wired providers appear in the adapter catalogue and can be independently contract-tested. **All seven providers are enabled for cloud checkout, sandbox test-order creation, provider webhook ingress and provider activation in test mode. Live collection remains disabled for all providers.** The server now enforces this registry allowlist at each of those execution routes; adapter wiring alone cannot enable a cloud payment route. All seven provider routes are test-only. Live collection remains disabled. CCAvenue supports hosted checkout, status lookup and encrypted callbacks; ordinary refunds remain unsupported until its merchant-specific API contract is obtained. Their credential records may be provisioned for future qualification, but they cannot initiate or activate checkout. Paytm's adapter environments map staging/production; JioPay maps UAT/production. Provider adapter tests use deterministic mocked responses and are not merchant UAT.

This does **not** mean merchant acceptance is complete. Provider-specific merchant credentials, real sandbox transactions, webhook delivery, refund UAT, retry/recovery under provider outages and physical Android checkout acceptance must still be run against each merchant account. Android checkout handoff is currently released only for Razorpay and Cashfree. CCAvenue is now factory-wired for documented hosted checkout, encrypted callback verification and order-status API operations. Standard refunds are not claimed: the public API guide documents splitRefund only for split-payout transactions, so ordinary refund operations remain blocked pending the merchant-specific refund contract. The capability API reports live collection, refunds, reconciliation and folio settlement as disabled for all providers.

See [Hybrid Payment Architecture](../docs/HYBRID_PAYMENT_ARCHITECTURE.md) and [Provider Integration Status](../docs/PROVIDER_INTEGRATION_STATUS.md).

## Financial safety

- Never expose merchant secrets to Android, JavaScript, logs, analytics or source control.
- Verify provider status independently; client callbacks are untrusted hints.
- Persist idempotency identities and immutable provider references before dispatch.
- Treat network timeouts as ambiguous and reconcile before retrying.
- Capture and folio settlement are separate states. Use a durable outbox/saga if the payment database and PMS accounting database differ.
- The LAN SQLite command journal now has database-enforced binding and immutability guards. A device command must exactly match its captured transaction identity, device, folio, amount and currency. A transaction cannot transition to `SETTLED` unless the matching command is processed with a durable receipt, receipt signature and advanced device cursor. These triggers protect the LAN server's transaction boundary only; they do not prove that the Android PMS IndexedDB folio and LAN SQLite share one atomic transaction.
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
