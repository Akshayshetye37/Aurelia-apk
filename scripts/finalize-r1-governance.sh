#!/usr/bin/env bash
set -Eeuo pipefail

: "${R1_ADMIN_TOKEN:?Set the R1_ADMIN_TOKEN Actions secret to a fine-grained PAT with Administration: write, Contents: write, Actions: read, and Checks: read}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
: "${GITHUB_SHA:?GITHUB_SHA is required}"
case "${GITHUB_REF:-}" in
  "refs/heads/release/r1-local-first-execution"|"refs/heads/admin-finalize/r1") ;;
  *) echo "::error::Run only from release/r1-local-first-execution or admin-finalize/r1."
     exit 1 ;;
esac

export GH_TOKEN="$R1_ADMIN_TOKEN"
REPO="$GITHUB_REPOSITORY"
RULESET_NAME="Aurelia R1 protected branches"
RED_SHA="036b3f31029687345a0ee19c8a9740172d4507b3"
CHECK_BRANCH="test/r1-protection-checks-probe-$GITHUB_RUN_ID"
PROBE_BRANCH="release/r1-protection-probe-$GITHUB_RUN_ID"
TAG="aurelia-approved-probe-red-036b3f3-$GITHUB_RUN_ID"
CHECK_BRANCH_CREATED=0
PROBE_BRANCH_CREATED=0
TAG_CREATED=0

cleanup() {
  if [[ "$TAG_CREATED" == "1" ]]; then
    gh api --method DELETE "repos/$REPO/git/refs/tags/$TAG" >/dev/null 2>&1 || true
  fi
  if [[ "$PROBE_BRANCH_CREATED" == "1" ]]; then
    gh api --method DELETE "repos/$REPO/git/refs/heads/$PROBE_BRANCH" >/dev/null 2>&1 || true
  fi
  if [[ "$CHECK_BRANCH_CREATED" == "1" ]]; then
    gh api --method DELETE "repos/$REPO/git/refs/heads/$CHECK_BRANCH" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "Checking the red-SHA fixture before testing tag rejection..."
RED_CHECKS="$(gh api "repos/$REPO/commits/$RED_SHA/check-runs?per_page=100")"
echo "$RED_CHECKS" | jq -e '[.check_runs[] | select(.name == "r1-governance" and .status == "completed" and .conclusion == "failure")] | length > 0' >/dev/null

BASE_RULES="$(jq -n '[
  {
    type: "pull_request",
    parameters: {
      allowed_merge_methods: ["merge", "squash", "rebase"],
      dismiss_stale_reviews_on_push: true,
      require_code_owner_review: false,
      require_last_push_approval: false,
      required_approving_review_count: 1,
      required_review_thread_resolution: true
    }
  },
  {
    type: "required_status_checks",
    parameters: {
      do_not_enforce_on_create: false,
      required_status_checks: [{context: "r1-governance"}, {context: "native-security-kotlin"}],
      strict_required_status_checks_policy: true
    }
  },
  {type: "non_fast_forward"}
]')"

FINAL_RULES="$(echo "$BASE_RULES" | jq '. + [{type: "deletion"}]')"

RULESET_BASE="$(jq -n --arg name "$RULESET_NAME" --arg repo "$REPO" --argjson rules "$BASE_RULES" '{
  name: $name,
  target: "branch",
  source: $repo,
  enforcement: "active",
  bypass_actors: [],
  conditions: {
    ref_name: {
      include: [
        "refs/heads/main",
        "refs/heads/feature/multi-provider-payment-backend",
        "refs/heads/release/**"
      ],
      exclude: []
    }
  },
  rules: $rules
}')"

RULESET_FINAL="$(echo "$RULESET_BASE" | jq --argjson rules "$FINAL_RULES" '.rules = $rules')"

RULESET_ID="$(gh api "repos/$REPO/rulesets?per_page=100" --jq ".[] | select(.name == \"$RULESET_NAME\") | .id" | head -n1 || true)"
if [[ -n "$RULESET_ID" ]]; then
  echo "Updating existing ruleset $RULESET_ID without deletion restriction for safe probe cleanup..."
  printf '%s' "$RULESET_BASE" | gh api --method PUT "repos/$REPO/rulesets/$RULESET_ID" --input -
else
  echo "Creating the R1 protected-branches ruleset..."
  RULESET_ID="$(printf '%s' "$RULESET_BASE" | gh api --method POST "repos/$REPO/rulesets" --input - --jq '.id')"
fi

git fetch origin refs/heads/release/r1-local-first-execution:refs/remotes/origin/release/r1-local-first-execution
BASE_SHA="$(git rev-parse refs/remotes/origin/release/r1-local-first-execution)"
gh api "repos/$REPO/commits/$BASE_SHA/check-runs?per_page=100" | jq -e '[.check_runs[] | select((.name == "r1-governance" or .name == "native-security-kotlin") and .status == "completed" and .conclusion == "success")] | unique_by(.name) | length == 2' >/dev/null
echo "Creating an unprotected temporary check branch $CHECK_BRANCH at $BASE_SHA..."
gh api --method POST "repos/$REPO/git/refs" -f "ref=refs/heads/$CHECK_BRANCH" -f "sha=$BASE_SHA" >/dev/null
CHECK_BRANCH_CREATED=1

git checkout --detach "$BASE_SHA"
git -c user.name="R1 governance verifier" -c user.email="r1-governance@users.noreply.github.com" commit --allow-empty -m "test: produce a green R1 governance SHA for direct-push probe"
PROBE_SHA="$(git rev-parse HEAD)"
AUTH_HEADER="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$R1_ADMIN_TOKEN" | base64 -w0)"
git -c http.extraheader="$AUTH_HEADER" push origin "HEAD:refs/heads/$CHECK_BRANCH"

echo "Waiting for r1-governance to pass on exact probe SHA $PROBE_SHA..."
GOVERNANCE_WORKFLOW_ID="$(gh api "repos/$REPO/actions/workflows/r1-governance.yml" --jq '.id')"
GOVERNANCE_RUN_ID=""
GOVERNANCE_CONCLUSION=""
for attempt in $(seq 1 72); do
  GOVERNANCE_RUN_ID="$(gh api "repos/$REPO/actions/runs?event=push&per_page=100" --jq --argjson workflow_id "$GOVERNANCE_WORKFLOW_ID" --arg sha "$PROBE_SHA" '
    [.workflow_runs[] | select(.workflow_id == $workflow_id and .head_sha == $sha)] | sort_by(.created_at) | last | (.id // empty)
  ' | head -n1)"
  if [[ -n "$GOVERNANCE_RUN_ID" ]]; then
    GOVERNANCE_STATE="$(gh api "repos/$REPO/actions/runs/$GOVERNANCE_RUN_ID")"
    if [[ "$(echo "$GOVERNANCE_STATE" | jq -r '.status')" == "completed" ]]; then
      GOVERNANCE_CONCLUSION="$(echo "$GOVERNANCE_STATE" | jq -r '.conclusion')"
      break
    fi
  fi
  sleep 5
done
if [[ "$GOVERNANCE_CONCLUSION" != "success" ]]; then
  echo "::error::The temporary source SHA did not receive a successful r1-governance run."
  exit 1
fi
NATIVE_WORKFLOW_ID="$(gh api "repos/$REPO/actions/workflows/native-security-kotlin.yml" --jq '.id')"
NATIVE_RUN_ID=""
NATIVE_CONCLUSION=""
for attempt in $(seq 1 72); do
  NATIVE_RUN_ID="$(gh api "repos/$REPO/actions/runs?event=push&per_page=100" --jq --argjson workflow_id "$NATIVE_WORKFLOW_ID" --arg sha "$PROBE_SHA" '
    [.workflow_runs[] | select(.workflow_id == $workflow_id and .head_sha == $sha)] | sort_by(.created_at) | last | (.id // empty)
  ' | head -n1)"
  if [[ -n "$NATIVE_RUN_ID" ]]; then
    NATIVE_STATE="$(gh api "repos/$REPO/actions/runs/$NATIVE_RUN_ID")"
    if [[ "$(echo "$NATIVE_STATE" | jq -r '.status')" == "completed" ]]; then
      NATIVE_CONCLUSION="$(echo "$NATIVE_STATE" | jq -r '.conclusion')"
      break
    fi
  fi
  sleep 5
done
if [[ "$NATIVE_CONCLUSION" != "success" ]]; then
  echo "::error::The temporary source SHA did not receive a successful native-security-kotlin run."
  exit 1
fi
gh api "repos/$REPO/commits/$PROBE_SHA/check-runs?per_page=100" | jq -e '[.check_runs[] | select((.name == "r1-governance" or .name == "native-security-kotlin") and .status == "completed" and .conclusion == "success")] | unique_by(.name) | length == 2' >/dev/null

echo "Creating protected target branch $PROBE_BRANCH at $BASE_SHA..."
gh api --method POST "repos/$REPO/git/refs" -f "ref=refs/heads/$PROBE_BRANCH" -f "sha=$BASE_SHA" >/dev/null
PROBE_BRANCH_CREATED=1

echo "Attempting direct push of an already-green SHA to the protected release branch..."
set +e
git -c http.extraheader="$AUTH_HEADER" push origin "HEAD:refs/heads/$PROBE_BRANCH" >/tmp/r1-protection-push.log 2>&1
PUSH_EXIT=$?
set -e
cat /tmp/r1-protection-push.log
if [[ "$PUSH_EXIT" -eq 0 ]]; then
  echo "::error::Direct push unexpectedly succeeded on the protected probe branch."
  exit 1
fi
if ! grep -Eqi 'GH013|repository rule violations|protected branch update failed|push declined due to repository rule' /tmp/r1-protection-push.log; then
  echo "::error::Push failed, but not with a GitHub branch-protection rejection. Refusing to count this as a passing probe."
  exit 1
fi
echo "GitHub rejected the direct push even though r1-governance was already green for the exact commit."

echo "Removing both disposable branches before enabling deletion protection..."
gh api --method DELETE "repos/$REPO/git/refs/heads/$PROBE_BRANCH" >/dev/null
PROBE_BRANCH_CREATED=0
gh api --method DELETE "repos/$REPO/git/refs/heads/$CHECK_BRANCH" >/dev/null
CHECK_BRANCH_CREATED=0

echo "Enabling deletion protection and verifying the final ruleset..."
printf '%s' "$RULESET_FINAL" | gh api --method PUT "repos/$REPO/rulesets/$RULESET_ID" --input - >/dev/null
FINAL_STATE="$(gh api "repos/$REPO/rulesets/$RULESET_ID")"
echo "$FINAL_STATE" | jq -e '
  .enforcement == "active" and
  .bypass_actors == [] and
  (.conditions.ref_name.include | index("refs/heads/main") != null) and
  (.conditions.ref_name.include | index("refs/heads/feature/multi-provider-payment-backend") != null) and
  (.conditions.ref_name.include | index("refs/heads/release/**") != null) and
  ([.rules[].type] | index("pull_request") != null) and
  ([.rules[].type] | index("required_status_checks") != null) and
  ([.rules[].type] | index("non_fast_forward") != null) and
  ([.rules[].type] | index("deletion") != null) and
  ([.rules[] | select(.type == "pull_request") | .parameters.required_approving_review_count] | index(1) != null) and
  ([.rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context] | index("r1-governance") != null) and
  ([.rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context] | index("native-security-kotlin") != null)
' >/dev/null

echo "Creating a temporary approved-pattern tag pointing to the known-red SHA..."
gh api --method POST "repos/$REPO/git/refs" -f "ref=refs/tags/$TAG" -f "sha=$RED_SHA" >/dev/null
TAG_CREATED=1
WORKFLOW_ID="$(gh api "repos/$REPO/actions/workflows/release-tag-guard.yml" --jq '.id')"
TAG_RUN_ID=""
CONCLUSION=""
for attempt in $(seq 1 36); do
  TAG_RUN_ID="$(gh api "repos/$REPO/actions/runs?event=push&per_page=100" --jq --argjson workflow_id "$WORKFLOW_ID" --arg sha "$RED_SHA" '
    [.workflow_runs[] | select(.workflow_id == $workflow_id and .head_sha == $sha)] | sort_by(.created_at) | last | (.id // empty)
  ' | head -n1)"
  if [[ -n "$TAG_RUN_ID" ]]; then
    RUN_STATE="$(gh api "repos/$REPO/actions/runs/$TAG_RUN_ID")"
    if [[ "$(echo "$RUN_STATE" | jq -r '.status')" == "completed" ]]; then
      CONCLUSION="$(echo "$RUN_STATE" | jq -r '.conclusion')"
      break
    fi
  fi
  sleep 5
done

if [[ -z "$TAG_RUN_ID" ]]; then
  echo "::error::Release-tag guard did not start for the temporary red-SHA tag."
  exit 1
fi
if [[ "$CONCLUSION" != "failure" ]]; then
  echo "::error::Expected the release-tag guard to refuse the red SHA; observed conclusion '$CONCLUSION'."
  exit 1
fi
TAG_LOG="$(gh run view "$TAG_RUN_ID" --repo "$REPO" --log)"
if ! grep -Fq "Release tag refused. Required checks are not all green" <<<"$TAG_LOG"; then
  echo "::error::The tag workflow failed, but its logs do not prove the expected red-check refusal."
  exit 1
fi

echo "Release-tag guard correctly refused the red SHA (run $TAG_RUN_ID)."
gh api --method DELETE "repos/$REPO/git/refs/tags/$TAG" >/dev/null
TAG_CREATED=0

{
  echo "## R1 governance enforcement"
  echo ""
  echo "- Ruleset: [Aurelia R1 protected branches](https://github.com/$REPO/rules/$RULESET_ID) — active, verified."
  echo "- Protected refs: `main`, `feature/multi-provider-payment-backend`, `release/**`."
  echo "- Required checks: `r1-governance` and `native-security-kotlin`; approvals: 1; force-push and deletion blocked; bypass actors: none."
  echo "- Direct push probe: rejected on `$PROBE_BRANCH` even though the pushed SHA already had both required checks green; both disposable branches removed."
  echo "- Red-SHA tag probe: refused by [release-tag guard run $TAG_RUN_ID](https://github.com/$REPO/actions/runs/$TAG_RUN_ID); temporary tag removed."
} >> "$GITHUB_STEP_SUMMARY"
