# Aurelia local payment administration (Docker)

This runtime is the local owner/provider-administration foundation. It is not yet a production payment-collection or PMS-settlement service. Live collection is intentionally blocked.

## Prerequisites

- Docker Engine / Docker Desktop with Compose.
- A stable LAN hostname or IP for the host.
- A trusted local TLS certificate on every PMS browser/WebView device. Caddy's `tls internal` creates a private CA; install and trust that CA on each client device before using the HTTPS endpoint. Do not bypass certificate warnings.
- Node 22 is used in the container; host operating system does not determine the runtime.

## First start

1. Copy `.env.example` to `.env`.
2. Generate two independent 32-byte secrets:
   `openssl rand -hex 32`
   Set one as `GATEWAY_MASTER_KEY` and the other as `SESSION_TOKEN_PEPPER`. Never reuse either value or commit `.env`.
3. Replace `YOUR-LAN-HOSTNAME` with the exact host name/IP used by the PMS device. Keep the origin exact, including `:8443`.
4. Start with `docker compose up -d --build`.
5. Check `https://YOUR-LAN-HOSTNAME:8443/healthz` and `/readyz`.
6. Complete one-time owner setup through `POST /v1/auth/setup` with a username and a password of at least 14 characters. There is no default account or password.
7. Sign in through `POST /v1/auth/login`. The backend returns a Secure, HttpOnly, SameSite=Strict cookie. Cross-origin clients must use credentialed requests and the exact configured origin.

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
- `POST /v1/admin/providers/:provider/deactivate`
- `DELETE /v1/admin/providers/:provider/credentials?environment=test|live`
- `POST /v1/webhooks/:provider/:environment` (raw request body; provider-specific signature verification)

## Safety boundary

- Credentials are encrypted at rest with AES-256-GCM and a fresh 12-byte IV per write.
- Provider validation makes a real authenticated read-only API request through the existing provider adapter; it does not create a charge.
- Saving or rotating credentials clears validation and activation.
- Live activation and live payment collection are not enabled.
- Provider removal checks persisted unresolved transaction states. Payment creation, transaction dispatch, status reconciliation, refunds, and atomic PMS folio settlement are not implemented in this local runtime yet. A webhook signature being valid is recorded as an inbox event only; it is not a payment or settlement confirmation.
- PMS integration must send the session cookie using `credentials: 'include'`; it must not put provider credentials or session tokens in localStorage, Android preferences, or APK resources.

## Operational caveats

Caddy's internal CA is not automatically trusted by Android or desktop clients. Install the generated root certificate through an administrator-controlled process. Public gateway webhooks cannot reach a private LAN address; a separately approved public ingress or outbound reconciliation design is required before webhook-driven production payments. Never expose the backend directly to the public internet.
