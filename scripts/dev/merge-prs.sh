#!/usr/bin/env bash
# The only sanctioned way to merge: serialized, in the order given, with merge commits (stacked diffs stay per-issue).
# For each PR: base must be main and mergeable, a `## Review —` comment must exist (--no-review-gate to skip),
# then merge → retarget every open PR based on the merged head branch to main → delete the head branch.
# Deleting a base branch first would CLOSE the dependent PRs (GitHub does not retarget on `git push --delete`).
set -euo pipefail
gate=1
if [[ "${1:-}" == "--no-review-gate" ]]; then gate=0; shift; fi
[[ $# -gt 0 ]] || { echo "usage: merge-prs.sh [--no-review-gate] <pr> [<pr>…]" >&2; exit 1; }
export OCULITH_MERGE=1

merge_one() {
  local pr=$1 base state head body i dep
  for i in $(seq 1 30); do
    read -r base state head < <(gh pr view "$pr" --json baseRefName,mergeStateStatus,headRefName --jq '"\(.baseRefName) \(.mergeStateStatus) \(.headRefName)"')
    [[ "$base" == main && "$state" != UNKNOWN ]] && break
    sleep 4
  done
  [[ "$base" == main ]] || { echo "STOP: PR #$pr base is $base, expected main (merge its parent first)" >&2; exit 1; }
  case "$state" in CLEAN|UNSTABLE|HAS_HOOKS) ;; *) echo "STOP: PR #$pr mergeStateStatus=$state — resolve by merging main into the branch (never rebase a pushed branch)" >&2; exit 1;; esac
  if [[ $gate == 1 ]] && ! gh pr view "$pr" --json comments,reviews --jq '[.comments[].body, .reviews[].body] | join("\n")' | grep -q '^## Review —'; then
    echo "STOP: PR #$pr has no '## Review —' comment; run a mergeability review first (or --no-review-gate with a reason)" >&2; exit 1
  fi
  gh pr merge "$pr" --merge --subject "$(gh pr view "$pr" --json title --jq .title) (#$pr)" >/dev/null || { echo "STOP: merge of #$pr failed" >&2; exit 1; }
  for dep in $(gh pr list --state open --base "$head" --json number --jq '.[].number'); do
    gh pr edit "$dep" --base main >/dev/null && echo "  retargeted #$dep -> main"
  done
  git push -q origin --delete "$head" 2>&1 | grep -v '^warning' || true
  body="$(gh pr view "$pr" --json body --jq .body)"
  for n in $(printf '%s' "$body" | grep -oiE '(closes|fixes|resolves) #[0-9]+' | grep -oE '[0-9]+'); do
    gh issue edit "$n" --remove-label in-review --remove-label in-progress >/dev/null 2>&1 || true
  done
  echo "merged #$pr ($head) state=$state"
}

for pr in "$@"; do merge_one "$pr"; done
if [[ "$(git branch --show-current)" == main && -z "$(git status --short)" ]]; then git pull -q --ff-only origin main && git log --oneline -1; fi
