# Gate 3 hardening changes

## Single callable inventory

`scripts/gates/callables.json` is the reviewed source of truth. Staging deployment loads it for its probes and reconciles it against the deployed Gen2 Functions list. Inventory mismatch fails closed.

## Reviewed production project ID

`scripts/gates/production-project.json` currently contains `UNCONFIGURED` because the authoritative production project ID was not discoverable in the repository. Gate 3 deliberately fails until an owner replaces this placeholder with the actual production project ID in a reviewed commit. The GitHub Environment `PRODUCTION_GCP_PROJECT_ID` must match the reviewed constant, and staging must differ.

Do not guess the project ID or point staging at production.

## Evidence contract

Before Gate 3 writes its record, `validate-gate3-evidence.mjs` validates non-empty probes, required missing/invalid App Check probe cases for every callable, HTTP 401/403 results, hashes, candidate SHA consistency, callable inventory consistency and exclusion reasons.

The evidence record retains separate status fields:

- `STAGING_DEPLOYMENT`
- `APPCHECK_NEGATIVE_PROBES`
- `APK_BUILD_AND_SIGNING`
- `PHYSICAL_SMS_RECOVERY`
- `GATE_3_OVERALL`

Staging evidence may be successful while Gate 3 overall remains NOT QUALIFIED. Physical qualification requires a committed matrix tied to the exact candidate SHA and reviewer sign-off.

## External security qualification

Code checks do not prove WIF trust restrictions or GCP IAM isolation. Those remain external qualification blockers and must be verified live in GCP. The deployment identity must not have production access; runtime service accounts must remain separate.
