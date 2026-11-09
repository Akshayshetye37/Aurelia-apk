#!/usr/bin/env bash
set -Eeuo pipefail

: "${R1_ADMIN_TOKEN:?Set the R1_ADMIN_TOKEN Actions secret to a fine-grained PAT with Administration: write, Contents: write, Actions: read, and Checks: read}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
: "${GITHUB_SHA:?GITHUB_SHA is required}"
if [[ "${GITHUB_REF:-}" != "refs/heads/release/r1-local-first-execution" ]]; then
  echo "::error::Run this workflow from release/r1-local-first-execution only."
  exit 1
fi

export GH_TOKEN="$R1_ADMIN_TOKEN"
REPO="$GITHUB_REPOSITORY"
RULESET_NAME="Aurelia R1 protected branches"
RED_SHA="036b3f31029687345a0ee19c8a9740172d4507b3"
PROBE_BRANCH="release/r1-protection-probe-$GITHUB_RUN_ID"
TAG="aurelia-approved-probe-red-036b3f3-$GITHUB_RUN_ID"
PROBE_BRANCH_CREATED=0
TAG_CREATED=0

cleanup() {
  if [[ "$TAG_CREATED" == "1" ]]; then
    gh api --method DELETE "repos/$REPO/git/refs/tags/$TAG" >/dev/null 2>&1 || true
  fi
  if [[ "$PROBE_BRANCH_CREATED" == "1" ]]; then
    gh api --method DELETE "repos/$REPO/git/refs/heads/$PROBE_BRANCH" >/dev/null 2>&1 || true
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
      required_status_checks: [{context: "r1-governance"}],
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

BASE_SHA="$(git rev-parse HEAD)"
echo "Creating disposable protected branch $PROBE_BRANCH at $BASE_SHA..."
gh api --method POST "repos/$REPO/git/refs" -f "ref=refs/heads/$PROBE_BRANCH" -f "sha=$BASE_SHA" >/dev/null
PROBE_BRANCH_CREATED=1

git checkout --detach "$BASE_SHA"
git -c user.name="R1 governance verifier" -c user.email="r1-governance@users.noreply.github.com" commit --allow-empty -m "test: verify protected release branch rejects direct pushes"
AUTH_HEADER="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$R1_ADMIN_TOKEN" | base64 -w0)"
set +e
git -c http.extraheader="$AUTH_HEADER" push origin "HEAD:refs/heads/$PROBE_BRANCH" >/tmp/r1-protection-push.log 2>&1
PUSH_EXIT=$?
set -e
cat /tmp/r1-protection-push.log
if [[ "$PUSH_EXIT" -eq 0 ]]; then
  echo "::error::Direct push unexpectedly succeeded on the protected probe branch."
  exit 1
fi
echo "Direct push was rejected as required."

echo "Removing the disposable probe branch before enabling deletion protection..."
gh api --method DELETE "repos/$REPO/git/refs/heads/$PROBE_BRANCH" >/dev/null
PROBE_BRANCH_CREATED=0

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
  ([.rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context] | index("r1-governance") != null)
' >/dev/null

echo "Creating a temporary approved-pattern tag pointing to the known-red SHA..."
gh api --method POST "repos/$REPO/git/refs" -f "ref=refs/tags/$TAG" -f "sha=$RED_SHA" >/dev/null
TAG_CREATED=1
WORKFLOW_ID="$(gh api "repos/$REPO/actions/workflows/release-tag-guard.yml" --jq '.id')"
RUN_ID=""
CONCLUSION=""
for attempt in $(seq 1 36); do
  RUN_ID="$(gh api "repos/$REPO/actions/runs?event=push&per_page=100" --jq --argjson workflow_id "$WORKFLOW_ID" --arg sha "$RED_SHA" '
    [.workflow_runs[] | select(.workflow_id == $workflow_id and .head_sha == $sha)] | sort_by(.created_at) | last | (.id // empty)
  ' | head -n1)"
  if [[ -n "$RUN_ID" ]]; then
    RUN_STATE="$(gh api "repos/$REPO/actions/runs/$RUN_ID")"
    if [[ "$(echo "$RUN_STATE" | jq -r '.status')" == "completed" ]]; then
      CONCLUSION="$(echo "$RUN_STATE" | jq -r '.conclusion')"
      break
    fi
  fi
  sleep 5
done

if [[ -z "$RUN_ID" ]]; then
  echo "::error::Release-tag guard did not start for the temporary red-SHA tag."
  exit 1
fi
if [[ "$CONCLUSION" != "failure" ]]; then
  echo "::error::Expected the release-tag guard to refuse the red SHA; observed conclusion '$CONCLUSION'."
  exit 1
fi

echo "Release-tag guard correctly refused the red SHA (run $RUN_ID)."
gh api --method DELETE "repos/$REPO/git/refs/tags/$TAG" >/dev/null
TAG_CREATED=0

{
  echo "## R1 governance enforcement"
  echo ""
  echo "- Ruleset: [Aurelia R1 protected branches](https://github.com/$REPO/rules/$RULESET_ID) — active, verified."
  echo "- Protected refs: `main`, `feature/multi-provider-payment-backend`, `release/**`."
  echo "- Required check: `r1-governance`; approvals: 1; force-push and deletion blocked; bypass actors: none."
  echo "- Direct push probe: rejected on `$PROBE_BRANCH`; disposable branch removed."
  echo "- Red-SHA tag probe: refused by [release-tag guard run $RUN_ID](https://github.com/$REPO/actions/runs/$RUN_ID); temporary tag removed."
} >> "$GITHUB_STEP_SUMMARY"
