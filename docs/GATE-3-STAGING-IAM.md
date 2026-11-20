# Gate 3 staging IAM configuration

`scripts/gates/staging-iam.json` is intentionally unconfigured until the actual staging deployment roles are reviewed. Replace `UNCONFIGURED` with the exact least-privilege role allowlist after provisioning and review.

The verifier checks the WIF provider condition against the exact repository/ref, repository attribute mapping, an exclusive service-account WIF binding, staging project-level direct IAM roles against the reviewed allowlist, no direct project binding for the deploy identity in production, and a harmless production Functions-list request that must be denied. Inherited organization/folder IAM and negative authentication from a fork or different branch still require live external review.

This does not prove fork/different-branch authentication failure by itself. That negative authentication test must be performed live and recorded as external qualification evidence. Never weaken the provider condition to make the staging workflow authenticate.
