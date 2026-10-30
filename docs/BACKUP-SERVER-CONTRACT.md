# Aurelia PMS owner-configured backup server contract

This is a provider-neutral HTTPS contract. The owner may host it on any server/cloud service capable of implementing these requests. The endpoint is configured by the owner; Aurelia does not provision a cloud account.

## Authentication and transport

- HTTPS is mandatory. HTTP endpoints and embedded URL credentials are rejected.
- Requests use Authorization: Bearer <owner-issued-token>.
- Redirects are rejected. Configure the final canonical HTTPS URL directly.
- The token is stored encrypted using Android Keystore AES-GCM. It is never written into PMS JavaScript state, the PMS backup JSON, or logs.
- Issue a dedicated, revocable token with upload/read access only to this PMS backup namespace. Do not reuse payment-provider API credentials.

## Health check

HEAD to the configured endpoint.

Headers:
- Authorization: Bearer ...
- X-Aurelia-Application: com.aurelia.pms

Return any 2xx status only when the token is authenticated and the endpoint is ready to accept/serve backups. 401/403 means the token is invalid or lacks access. Redirects are treated as failure.

## Upload

POST to the configured endpoint.

Headers:
- Authorization: Bearer ...
- Content-Type: application/json; charset=utf-8
- X-Aurelia-Application: com.aurelia.pms
- X-Aurelia-Backup-Schema: 4
- X-Aurelia-Backup-Name: aurelia-backup-<date>-<hash>.json
- X-Aurelia-Backup-SHA256: lowercase SHA-256 of exact request body bytes

Body: the complete PMS backup JSON document (not multipart).

Return 2xx only after the server has durably stored the complete body and verified the supplied SHA-256. A 2xx response is the server's acknowledgement. The server should store immutable/content-addressed versions and enforce its own retention policy; it must not overwrite a different backup with the same name. 4xx/5xx responses are surfaced as remote-copy warnings; the private local copy remains the primary verified copy.

## Restore latest

GET from the configured endpoint.

Headers:
- Authorization: Bearer ...
- X-Aurelia-Application: com.aurelia.pms

Return the latest complete PMS backup as the raw application/json body. Return 404 when no PMS backup exists. Do not return a Pay Bridge backup or another tenant's backup. The PMS client limits a server restore response to 25 MiB and validates the PMS schema and integrity before showing the normal restore confirmation.

## Server-side requirements

- Authenticate and authorize every request; isolate each owner's PMS namespace.
- Validate the application identifier, schema, filename and SHA-256. Do not trust the filename as a filesystem path.
- Reject path traversal, oversized bodies, invalid JSON and unsupported schemas.
- Store backups durably before returning success; use immutable versioning and an owner-defined retention policy.
- Encrypt stored backups at rest and restrict operator access. Keep access logs free of bearer tokens and guest data.
- Do not interpret PMS backup contents as payment-provider instructions or use them to settle folios.
