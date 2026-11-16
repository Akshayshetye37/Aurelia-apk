#!/usr/bin/env bash
set -euo pipefail
command -v gh >/dev/null || { echo "gh CLI is required" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
shopt -s nullglob
files=(.github/workflows/gate-*.yml .github/workflows/gate-*.yaml .github/workflows/recovery-staging-deploy.yml)
(("${#files[@]}" > 0)) || { echo "No gate workflows found" >&2; exit 1; }
for file in "${files[@]}"; do
  mapfile -t refs < <(grep -Eo 'uses: [^[:space:]#]+' "$file" | awk '{print $2}' | grep -E '@v[0-9]' | sort -u || true)
  for ref in "${refs[@]}"; do
    full="${ref%@*}"
    tag="${ref##*@}"
    if [[ ! "$full" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(/[^[:space:]]+)?$ ]]; then
      echo "Unsupported action reference: $ref" >&2; exit 1
    fi
    action_repo="${full%%/*}/${full#*/}"
    action_repo="${action_repo%%/*/*}"
    sha="$(gh api "repos/$action_repo/commits/$tag" --jq .sha)"
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "Could not resolve immutable SHA for $ref" >&2; exit 1; }
    python3 - "$file" "$ref" "$full@$sha" "$tag" <<'PY'
import pathlib, sys
path, old, new, tag = sys.argv[1:]
text = pathlib.Path(path).read_text()
needle = "uses: " + old
if needle not in text:
    raise SystemExit(f"expected action reference not found: {old}")
text = text.replace(needle, "uses: " + new + " # " + tag)
pathlib.Path(path).write_text(text)
PY
    echo "$file: $ref -> $full@$sha"
  done
done
