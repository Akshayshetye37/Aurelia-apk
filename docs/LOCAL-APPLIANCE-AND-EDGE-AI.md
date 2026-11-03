# Aurelia local appliance and optional edge-AI architecture

## Decision

Use a hybrid, local-first architecture. The Android PMS remains the user-facing edge client; the Pay Bridge remains a separate, same-device Android application reached only through the existing signature-protected Binder IPC contract; the physical LAN appliance hosts the payment API and, if a real AI feature is later approved, a separately isolated inference service.

Do **not** add TensorFlow Lite, PyTorch, an LLM, camera/microphone permissions, or GPU dependencies merely because they appear in a reference architecture. The current repository defines PMS and payment workflows, not a concrete AI task or trained model. Model choice and hardware acceleration are therefore deferred until there is a measurable feature, model artifact, latency target, and supported-device matrix.

## Target topology

```text
 Android phone / tablet
 ┌──────────────────────────────────────────────────────────┐
 │ Aurelia PMS                                               │
 │  • UI, bookings, guests, folios and local data             │
 │  • offline-first workflows                                 │
 │  • LAN service discovery + authenticated HTTPS client      │
 │       │                                                   │
 │       └── explicit Binder IPC (same-signature apps) ───┐  │
 │                                                        │  │
 │  Optional on-device inference (only for a defined task)│  │
 └────────────────────────────────────────────────────────┼──┘
                                                          ▼
                                                Aurelia Pay Bridge
                                                • provider hand-off
                                                • device key / attestation
                                                • idempotent request protocol

                    Wi-Fi / trusted property LAN
                              │
                              ▼
 Physical appliance
 ┌────────────────────────────────────────────────────────────────┐
 │ HTTPS reverse proxy (Caddy)                                    │
 │    │                                                           │
 │    ├── Payment API container (existing Node + SQLite service)   │
 │    │     • provider adapters                                    │
 │    │     • payment state / audit / reconciliation               │
 │    │     • persistent encrypted secrets and durable database    │
 │    │                                                           │
 │    ├── Optional isolated AI API container (future, separate)    │
 │    │     • local model runtime                                  │
 │    │     • CPU by default; GPU only on validated hardware        │
 │    │                                                           │
 │    └── Backup / restore agent and health monitoring             │
 │                                                                │
 │ mDNS/DNS-SD advertisement: _aurelia-payment._tcp.local          │
 └────────────────────────────────────────────────────────────────┘
```

## 1. Discovery: DNS-SD/mDNS, not a hard-coded IP

Advertise the payment endpoint as `_aurelia-payment._tcp.local.` from the appliance. The service record should resolve to the appliance hostname and HTTPS port 8443. TXT records may contain only non-secret metadata, for example:

- `api=1`
- `service=payment`
- `tls=required`

Never publish tokens, property IDs that are treated as secrets, provider credentials, signing keys, or database details in DNS-SD TXT records.

Android should use `NsdManager` to discover and resolve the service, then pass the resolved hostname to the HTTPS client. Discovery is a locator, **not authentication**. The app must authenticate the appliance using a provisioned private CA trust anchor or a carefully managed certificate/public-key pin. Do not accept an arbitrary certificate just because it was discovered on the local Wi-Fi.

Use an explicit owner-approved appliance enrollment/pairing flow to bind the property to its appliance identity. Cache the last known endpoint only as a recovery hint; revalidate TLS identity on every connection and rediscover after network changes.

## 2. Transport security: do not enable cleartext LAN HTTP

The sample pattern that permits cleartext traffic to `.local` or a private IP range is not suitable for payment traffic. A local network is not inherently trusted. Keep Android cleartext traffic disabled. Use HTTPS through the existing Caddy reverse proxy on port 8443, with a private CA/certificate lifecycle that the app can validate.

Do not use `TrustAll` managers, hostname-verification bypasses, self-signed-certificate acceptance prompts on every request, or a broad trust-all network security configuration. Do not pin a short-lived leaf certificate without a rotation plan. Prefer a provisioned private CA trust anchor; if public-key pinning is added, define backup pins and an emergency rotation procedure.

The existing Docker Compose topology uses a private bridge network between Caddy and the payment API. Preserve that isolation. Do not switch to `--network=host` casually: host networking changes the exposure boundary and makes `-p` port publishing ineffective.

## 3. Android connection lifecycle

Implement discovery and HTTPS calls behind one repository/service abstraction rather than scattering IP addresses through UI code.

1. Discover `_aurelia-payment._tcp` on the active Wi-Fi network.
2. Resolve the service and verify the expected service name, hostname policy, and port.
3. Establish HTTPS and validate the provisioned appliance identity.
4. Call `/healthz` for liveness and `/readyz` for readiness. A healthy process is not necessarily a ready payment service.
5. On network change or request timeout, cancel stale discovery, rediscover, and retry only operations that are safe to retry.
6. Use an idempotency key for every payment mutation. Never blindly replay a create/capture/refund after an ambiguous timeout; query the existing operation by its idempotency key and reconcile its state.
7. Expose connection states clearly: `DISCOVERING`, `CONNECTED`, `UNAVAILABLE`, `TLS_IDENTITY_ERROR`, and `SERVICE_NOT_READY`.

Do not hold a Wi-Fi lock continuously. It increases battery consumption and does not repair a broken network. Use a foreground service only for a user-visible, genuinely long-running operation that Android background-execution rules require.

## 4. Offline and failure behavior

Aurelia PMS must remain usable when the appliance or Wi-Fi is unavailable. Bookings, guest records, room operations, folios, invoices, and manual/offline payment records must not become dependent on the payment appliance.

For an online payment:
- If the appliance cannot be reached before a payment request is created, show that online payment is unavailable and preserve the PMS workflow.
- If the connection fails after a payment request may have reached the provider, mark the operation as pending/unknown and reconcile. Do not tell the guest it failed and do not create a second charge automatically.
- Mark a folio paid only after the server has verified the provider result and the PMS accounting operation has committed exactly once.
- If the appliance returns, reconcile pending operations before enabling another attempt for the same business transaction.

On-device AI fallback is relevant only if an approved AI feature exists. It must not be used as a fallback authority for payment status, accounting, identity verification, or security decisions.

## 5. Optional AI service: isolate it from payment processing

If a future feature needs local AI (for example, property FAQ retrieval or document classification), run it as a separate service with its own container, resource limits, model files, API authentication, and health check. The payment API must continue to work if the AI service is stopped, overloaded, or compromised.

- Start CPU-only; add GPU/NPU acceleration only after benchmarking the actual appliance and model.
- Keep model downloads out of the payment container and production startup path.
- Use quantized/optimized models only after measuring answer quality and latency on the target hardware.
- Do not send guest PII, payment credentials, or card data to an AI model unless a reviewed data-flow and retention policy explicitly permits it.
- Treat model output as untrusted suggestions. It cannot authorize refunds, change folio balances, approve payments, or bypass owner permissions.
- If a small, deterministic mobile task is later identified, evaluate TensorFlow Lite/MediaPipe on Android separately. Do not add a large runtime to the PMS APK without a demonstrated need.

## 6. Appliance deployment and operations

Keep the current Caddy + payment-backend Compose deployment as the production baseline. Before installation:

- Provision a stable appliance hostname and DHCP reservation.
- Provision the private CA/certificate and the Android trust/enrollment path.
- Create all backend secrets on the appliance using a secret manager or protected environment file with restrictive filesystem permissions. Never commit `.env`, API keys, signing keys, or merchant credentials.
- Mount persistent storage for SQLite and Caddy state; verify ownership and free space.
- Configure encrypted off-device backups. A Docker volume is persistence, not a backup.
- Test restore onto a clean appliance and verify payment/audit records before accepting traffic.
- Restrict port 8443 to the property LAN/firewall allowlist. Do not expose the payment API port 8085 directly.
- Monitor `/healthz`, `/readyz`, disk space, backup age, certificate expiry, and container restart count.
- Use an immutable image tag/digest for releases; avoid deploying `:latest` as the only rollback reference.

The current Compose file does not itself configure mDNS advertisement, private-CA provisioning, host firewall rules, backup scheduling, or an actual physical appliance. Those are installation and operations steps, not features that GitHub CI can perform remotely.

## 7. Acceptance gates

Do not enable live payment processing until all applicable gates pass:

1. CI: backend tests, security checks, Android build, manifest policy, and signed release artifact verification pass on the exact release commit.
2. Appliance: clean install, HTTPS identity validation, service discovery, readiness, restart recovery, disk-full behavior, and backup/restore are tested on the target hardware.
3. Android: test the installed PMS + Pay Bridge APK pair on supported Android versions; verify signer identity, Binder permission enforcement, attestation, network-change recovery, and TLS rejection of an impostor appliance.
4. Payments: Razorpay and Cashfree sandbox success, failure, timeout, duplicate webhook, delayed webhook, refund, and reconciliation scenarios pass.
5. Accounting: a provider-confirmed payment updates the PMS folio exactly once; ambiguous states never silently become paid.
6. Operations: owner runbook, certificate rotation, key rotation, restore procedure, and incident rollback are documented and rehearsed.

## Current repository boundary

The repository contains Android integration templates and a LAN payment backend, but not a complete native Android application source tree for the discovery client and not a deployed physical appliance. Treat the Android NSD client, certificate provisioning, mDNS advertisement, and optional AI service as implementation/deployment work to be integrated and tested—not as already shipped functionality.
