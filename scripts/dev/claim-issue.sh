#!/usr/bin/env bash
# Claim GitHub issue N for this session before branching: assignee + label `in-progress`.
# Refuses when the issue is closed, already claimed (in-progress / in-review), assigned to someone else,
# or a branch for it already exists on origin. Re-reads after labelling so two simultaneous claimers
# both notice the collision (GitHub has no compare-and-set; the window is one round trip).
set -euo pipefail
n="${1:?usage: claim-issue.sh <issue-number>}"
me="$(gh api user --jq .login)"
json="$(gh issue view "$n" --json state,labels,assignees,title)"
state="$(node -pe 'JSON.parse(process.argv[1]).state' "$json")"
labels="$(node -pe 'JSON.parse(process.argv[1]).labels.map(l=>l.name).join(",")' "$json")"
assignees="$(node -pe 'JSON.parse(process.argv[1]).assignees.map(a=>a.login).join(",")' "$json")"
title="$(node -pe 'JSON.parse(process.argv[1]).title' "$json")"
[[ "$state" == "OPEN" ]] || { echo "claim-issue: #$n is $state" >&2; exit 1; }
case ",$labels," in *,in-progress,*|*,in-review,*) echo "claim-issue: #$n is already claimed ($labels; assignees: ${assignees:-none}). Pick another issue or ask the owner." >&2; exit 1;; esac
if [[ -n "$assignees" && "$assignees" != "$me" ]]; then echo "claim-issue: #$n is assigned to $assignees" >&2; exit 1; fi
existing="$(git ls-remote --heads origin "refs/heads/feat/$n-*" "refs/heads/fix/$n-*" "refs/heads/chore/$n-*" | awk '{print $2}' | sed 's|refs/heads/||' | tr '\n' ' ')"
if [[ -n "$existing" ]]; then echo "claim-issue: a branch for #$n already exists on origin: $existing — continue on it (git switch) instead of starting a second one." >&2; exit 1; fi
gh issue edit "$n" --add-assignee "$me" --add-label in-progress >/dev/null
# Lost a race if someone else is now assigned too.
after="$(gh issue view "$n" --json assignees --jq '.assignees | map(.login) | join(",")')"
if [[ "$after" != "$me" ]]; then
  gh issue edit "$n" --remove-assignee "$me" >/dev/null || true
  echo "claim-issue: #$n was claimed concurrently by $after — backing off." >&2; exit 1
fi
echo "claimed #$n ($title) for $me — label in-progress. Next: git switch -c feat/$n-<slug> origin/main"
