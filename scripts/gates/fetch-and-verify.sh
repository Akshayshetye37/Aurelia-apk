#!/usr/bin/env bash
# Downloads upstream evidence, verifies sigstore attestations, then validates content.
set -euo pipefail
: "${REPO:?}" "${CANDIDATE_SHA:?}" "${RUN_IDS:?}" "${REQUIRE:?}" "${GH_TOKEN:?}"
[[ "$CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "bad sha"; exit 1; }
[[ "$RUN_IDS" =~ ^([1-6]:[0-9]+)(,[1-6]:[0-9]+)*$ ]] || { echo "bad run ids"; exit 1; }
[[ "$REQUIRE" =~ ^[1-6](,[1-6])*$ ]] || { echo "bad require"; exit 1; }
declare -A WF=([1]=gate-1-encrypted-storage.yml [2]=gate-2-recovery-runtime.yml [3]=gate-3-real-sms-staging.yml [4]=gate-4-physical-device.yml [5]=gate-5-production-security.yml)
rm -rf upstream && mkdir upstream
IFS=',' read -ra REQ <<< "$REQUIRE"
for g in "${REQ[@]}"; do
  id=""; IFS=',' read -ra P <<< "$RUN_IDS"
  for p in "${P[@]}"; do [[ "${p%%:*}" == "$g" ]] && id="${p#*:}"; done
  [[ -n "$id" ]] || { echo "no run id for gate $g"; exit 1; }
  gh run download "$id" --repo "$REPO" --name "gate-${g}-evidence-${CANDIDATE_SHA}" --dir "upstream/gate-${g}"
  gh attestation verify "upstream/gate-${g}/gate-${g}.json" --repo "$REPO" \
     --signer-workflow "${REPO}/.github/workflows/${WF[$g]}"
done
node scripts/gates/verify-qualification.mjs --sha "$CANDIDATE_SHA" --run-ids "$RUN_IDS" --require "$REQUIRE" --dir upstream ${EXTRA_VERIFY_ARGS:-}
