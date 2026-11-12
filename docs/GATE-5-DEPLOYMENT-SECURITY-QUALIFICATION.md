# Gate 5 — Deployment and security qualification

**Status: NOT EXECUTED.** Source CI is not proof of deployed IAM, App Check, secrets, revocation freshness or production flag state.

## Automated deployment probes

- `Recovery hardware-attestation verifier deploy` deploys Cloud Run without public invocation, grants `roles/run.invoker` only to the configured Functions runtime service account, then checks:
  - no `allUsers` or `allAuthenticatedUsers` invoker binding;
  - unauthenticated `/healthz` is denied;
  - authenticated `/healthz` succeeds only while Google revocation status is fresh;
  - authenticated malformed `/verify` is rejected.
- `Recovery staging deployment and APK` verifies staging Secret Manager secret versions, sets `RECOVERY_ENABLED=true` only in the staging project, binds the verifier service account and builds the staging APK.
- `Verify production recovery remains disabled` is a read-only workflow. It must pass against the production project and confirm every deployed recovery/attestation service has `RECOVERY_ENABLED=false` or the parameter is unset (default false).

## Remaining staging security probes

1. Missing and invalid App Check tokens must be rejected by every recovery callable.
2. A staging debug App Check token must be accepted only in the staging project; it must never be configured in production.
3. Missing verifier URL, invalid IAM, invalid certificate chain, stale Google revocation data, software-only attestation and unlocked/unverified boot must all fail closed.
4. Verify rate-limit lockouts by phone, tenant, device and IP; confirm retry-after behavior and privacy-safe logs.
5. Rotate the ES256 key: publish old+new public pins in the staging APK, switch the staging active kid/private key, prove new grants verify, allow old five-minute grants to expire, then remove the old pin in a later APK. Never reuse a kid.
6. Inspect Cloud Run, Functions and Android logs for OTP, raw phone, ID token, grant, PIN, recovery key or DEK leakage.

Record immutable run URLs, exact SHA, project, service account identities, APK fingerprints and redacted probe outcomes. Do not copy secrets or token values into evidence. Production recovery stays disabled.
