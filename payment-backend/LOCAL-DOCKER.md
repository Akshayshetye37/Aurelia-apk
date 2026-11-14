# Aurelia optional LAN payment administration (Docker)

This runtime is an optional LAN owner/provider-administration and payment-dispatch foundation for owners who have a trusted local appliance. It is not required for the Android app's local credential storage. It is not yet a production payment-collection or PMS-settlement service. Live collection is intentionally blocked.

## Prerequisites

- Docker Engine / Docker Desktop with Compose.
- A stable LAN hostname or IP for the host, resolvable from the Android device.
- A trusted TLS certificate whose SAN matches `AURELIA_LAN_HOSTNAME`. Caddy's `tls internal` issues a certificate for that exact hostname/IP using a private CA; install that CA through an administrator-controlled process on the Android device. The PMS APK's Network Security Config explicitly trusts system and user-installed CA roots while denying all cleartext traffic. Verify the hostname/SAN and TLS handshake in the actual signed APK. Never bypass certificate or hostname validation.
- Node 22 is used in the container; host operating system does not determine the runtime.

## First start

1. Copy `.env.example` to `.env`.
2. Generate three independent 32-byte secrets:
   `openssl rand -hex 32`
   Set them as `GATEWAY_MASTER_KEY`, `SESSION_TOKEN_PEPPER` and `OWNER_SETUP_TOKEN`. Never reuse these values or commit `.env`. Keep the setup token offline; it is required only for first-owner enrollment.
3. Set `AURELIA_LAN_HOSTNAME` to the stable DNS name or IP the Android device uses to reach the appliance. Set `AURELIA_OWNER_ORIGINS` to the exact PMS WebView origin, not the backend origin; the current Capacitor configuration uses `https://localhost`. The backend URL entered in PMS is `https://<AURELIA_LAN_HOSTNAME>:8443`.
4. Start with `docker compose up -d --build`. Caddy accepts TLS 1.2/1.3 only and sends an HSTS response header. The backend container port is private to the Compose network; do not publish it or connect clients directly to it.
5. Check `https://<AURELIA_LAN_HOSTNAME>:8443/healthz` and `/readyz`. The local `/readyz` response reports `database: ready`; it does not return the Cloud Run prototype's Firestore/Secret Manager check fields.
6. Complete one-time owner setup through `POST /v1/auth/setup` with `X-Aurelia-Setup-Token: <OWNER_SETUP_TOKEN>`, a username and a password of at least 14 characters. The setup token is checked in constant time, setup is single-use, and there is no default account or password. Do not expose the setup token in a browser URL, logs or screenshots.
7. Open More → Payment Gateway in Aurelia PMS, save the backend origin and run Test backend. The integrated LAN owner console checks setup status, performs first-owner setup or sign-in, and manages supported provider credentials. Sign-in uses a Secure, HttpOnly, SameSite=None cookie because the Capacitor WebView origin (`https://localhost`) differs from the appliance origin; the Android WebView accepts third-party cookies for this app. The backend still requires an exact allowlisted Origin and credentialed CORS. The cookie is never exposed to JavaScript or returned in JSON. For a browser preview, add that exact HTTPS origin to `AURELIA_OWNER_ORIGINS` only if you explicitly trust that preview origin.

## Persistence and key recovery

SQLite lives in the named `payment-data` volume. The encryption key and session pepper live outside the container in the host-side `.env`. Back up the database and encryption key together using an encrypted, access-controlled backup process. Losing the master key makes stored gateway credentials unrecoverable. Rotating the key requires a planned decrypt/re-encrypt migration; do not simply replace it.

## Current API surface

- `GET /v1/auth/setup-status`
- `POST /v1/auth/setup`, `POST /v1/auth/login`, `GET /v1/auth/session`, `POST /v1/auth/logout`
- `POST /v1/auth/change-password`
- `GET /v1/admin/providers`
- `PUT /v1/admin/providers/:provider/credentials?environment=test|live` with body `{ "credentials": { ... } }`
- `POST /v1/admin/providers/:provider/validate` with `{ "environment": "test|live" }`
- `POST /v1/admin/providers/:provider/activate` with `{ "environment": "test", "confirm": true }`
- `POST /v1/admin/devices/register` with a P-256 SPKI public key
- `POST /v1/admin/devices/:deviceId/challenge` → five-minute single-use nonce and exact `signingPayload` transcript
- `POST /v1/admin/devices/:deviceId/activate` with challenge ID, nonce and base64url DER signature
- `POST /v1/admin/devices/:deviceId/revoke`
- `POST /v1/devices/:deviceId/commands/lease` (device P-256 request signature required)
- `POST /v1/devices/:deviceId/commands/:commandId/ack` (signed durable receipt; exact sequence and payload hash required)
- `POST /v1/admin/providers/:provider/deactivate`
- `DELETE /v1/admin/providers/:provider/credentials?environment=test|live`
- `POST /v1/webhooks/:provider/:environment` (raw request body; provider-specific signature verification)

## PMS owner-console integration\n\nThis optional LAN owner console is independent of Pay Bridge and independent of the Android native local credential vault. It currently supports Razorpay and Cashfree sandbox credentials, credential validation, explicit test activation/deactivation and credential removal. It does not expose production activation. The provider catalogue entries without a backend adapter remain documentation-only.\n\n## Safety boundary

- Credentials are encrypted at rest with AES-256-GCM and a fresh 12-byte IV per write.
- Provider validation makes a real authenticated read-only API request through the existing provider adapter; it does not create a charge.
- Saving or rotating credentials clears validation and activation.
- Live activation and live payment collection are not enabled.
- Provider removal checks persisted unresolved transaction states. Test-environment payment dispatch and provider API reconciliation are implemented as a restricted foundation. Device registration now requires P-256 proof-of-possession before activation; command leases and acknowledgements require signed device requests, contiguous sequence, exact payload hash, and durable-applied receipt. Provider webhooks are signature-checked and followed by an independent provider API status fetch; a verified capture is durably enqueued as a device settlement command only when the transaction has a device/folio binding. This does not itself post the PMS folio. Android native signer/consumer wiring, recovery authorization, end-to-end exactly-once folio posting, refunds, and operational reconciliation scheduling remain unfinished. Do not enable live collection. Reuse of an event ID with a different payload hash is rejected as an identity conflict.
- LAN-mode PMS integration must send the session cookie using `credentials: 'include'`; it must not put provider credentials or session tokens in localStorage, plain Android preferences, or APK resources. Local Native Mode uses the Android Keystore vault instead.

## Operational caveats

Caddy's internal CA is not automatically trusted by Android or desktop clients. Install the generated root certificate through an administrator-controlled process. Public gateway webhooks cannot reach a private LAN address; a separately approved public ingress or outbound reconciliation design is required before webhook-driven production payments. Never expose the backend directly to the public internet.
