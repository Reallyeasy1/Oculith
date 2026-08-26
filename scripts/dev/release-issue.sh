#!/usr/bin/env bash
# Move a claimed issue along: --review when its PR is open (in-progress → in-review), --abort to drop the claim.
set -euo pipefail
n="${1:?usage: release-issue.sh <issue-number> --review|--abort}"
mode="${2:?--review or --abort}"
case "$mode" in
  --review) gh issue edit "$n" --remove-label in-progress --add-label in-review >/dev/null; echo "#$n → in-review";;
  --abort)  me="$(gh api user --jq .login)"; gh issue edit "$n" --remove-label in-progress --remove-label in-review --remove-assignee "$me" >/dev/null; echo "#$n claim released";;
  *) echo "release-issue: unknown mode $mode" >&2; exit 1;;
esac
