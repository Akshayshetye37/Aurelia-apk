# R1 protected-branch enforcement

Repository ruleset enforcement is automated by `.github/workflows/r1-admin-finalize.yml`. The workflow applies and verifies the ruleset, attempts a real direct push to a disposable protected release branch, confirms GitHub rejects it, cleans up that branch, then enables deletion protection. It also creates a temporary `aurelia-approved-*` tag against a known-red commit, verifies the release-tag guard rejects it, and deletes the tag.

## One-time credential setup

The GitHub App connected to this workspace can read and write repository contents but cannot administer rulesets or create tags. Do not paste an administrator token into chat or commit it to the repository.

Create a **fine-grained personal access token** restricted to this repository with these permissions:

- **Administration: Read and write** — create/update the repository ruleset.
- **Contents: Read and write** — create/delete the disposable branch and tag.
- **Actions: Read** — poll the release-tag guard run.
- **Checks: Read** — verify the red commit has a completed failing `r1-governance` check.

Save it as the repository Actions secret named `R1_ADMIN_TOKEN`:

`Settings → Secrets and variables → Actions → New repository secret`.

## Run the finalizer

The workflow file is on the R1 execution branch, not yet on the default branch, so GitHub's manual `workflow_dispatch` UI may not list it. The supported trigger is a push to `admin-finalize/**`.

1. Add the `R1_ADMIN_TOKEN` repository secret as described above.
2. Confirm the secret is saved; do not paste its value into chat.
3. Tell the assistant **“R1 admin token added”**. The assistant can then create/update the dedicated `admin-finalize/r1` branch with a harmless trigger commit, which starts the workflow.
4. Wait for the job `apply-ruleset-and-run-negative-probes` to finish.
5. Confirm its job summary links to the active ruleset and the failed red-tag guard run. A successful workflow also means the direct-push probe was rejected and the temporary branch and tag were removed.

If this workflow is later merged into the default branch, it can also be run manually from **Actions → R1 administrator finalization → Run workflow**.

## Exact rules applied

The workflow creates or updates the repository ruleset **Aurelia R1 protected branches**:

- Target refs: `main`, `feature/multi-provider-payment-backend`, and `release/**`.
- Enforcement: active.
- Bypass actors: none, including administrators and repository roles.
- Require pull requests and one approving review.
- Dismiss stale approvals after new reviewable commits.
- Require resolved review conversations.
- Require the `r1-governance` status check and up-to-date checks.
- Block force pushes.
- Block branch deletion.

The direct-push probe is performed before enabling deletion protection so the disposable branch can be removed safely. The final ruleset is then read back and verified to contain the deletion rule as well.

## Failure handling

The workflow fails closed if the token lacks permissions, the red SHA is no longer known-red, ruleset read-back differs from the requested configuration, the direct push unexpectedly succeeds, the tag guard does not start, or the tag guard does not conclude `failure`. Cleanup is attempted on exit for temporary refs.

Packet 1 is not complete until this workflow finishes successfully and its evidence is attached to PR #13.
