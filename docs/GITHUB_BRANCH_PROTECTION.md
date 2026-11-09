# GitHub administrator action — R1 protected branches

The connected GitHub integration used for this execution branch does not have repository-administration permission (the branch-protection API returned HTTP 403). No branch-protection change or rejected-push experiment is claimed.

Apply the following settings in **Repository → Settings → Rules → Rulesets** (preferred) or **Branches → Branch protection rules**:

## Target branches

- `main`
- `release/*`

## Required rule configuration

- Require a pull request before merging.
- Require **1 approving review**.
- Require status check **`r1-governance`**.
- Require branches to be up to date before merging.
- Block force pushes.
- Block branch deletion.
- Do not add bypass actors; administrators must not bypass the rule.
- If using classic branch protection, enable **Include administrators** / enforce the rule for administrators.
- Do not enable an option that permits bypassing these requirements for administrators or repository roles.

The `r1-governance` check is defined by `.github/workflows/r1-governance.yml`. It runs the full application test suite, asserts the R1 release safety defaults, builds the production web bundle, and enforces the production asset boundary. It is intentionally not a substitute for packet-specific acceptance evidence.

## Required verification after saving

1. Re-open the ruleset and verify both branch patterns are targeted and active.
2. Verify `r1-governance` is selected as a required status check.
3. From a non-admin test clone/credential, attempt a direct push to a disposable protected test branch and a force-push; retain the exact server rejection output in the Packet 1 PR. Do not experiment with destructive pushes to `main` or a release branch.
4. Verify an administrator is also subject to the rule (no bypass list; admin enforcement enabled).
5. Record the ruleset URL/screenshot and test output in the Packet 1 PR.

**Packet 1 remains In progress until an administrator applies and verifies these settings.** A written configuration guide, workflow, or HTTP 403 is not proof that GitHub enforcement is active.
