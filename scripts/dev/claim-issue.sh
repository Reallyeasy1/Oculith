#!/usr/bin/env bash
# Claim GitHub issue N for yourself before branching: assignee + label `in-progress` + a claim-token comment.
# Refuses when the issue is closed, already claimed (in-progress / in-review), assigned to someone else, or a
# branch for it already exists on origin. GitHub has no compare-and-set, so after labelling we post a random claim
# token and back off if an earlier claim token from someone else is the first one on the issue — this catches two
# people (or two sessions sharing one login on different machines) claiming within the same round trip.
# Same-machine sessions are separated before this script runs: the guard hook records issue → session locally.
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
token="$(node -pe 'require("crypto").randomBytes(6).toString("hex")')"
gh issue edit "$n" --add-assignee "$me" --add-label in-progress >/dev/null
gh issue comment "$n" --body "claim-token: $token ($me)" >/dev/null
# Race window measured on the SERVER clock: the first non-released claim token posted within 90 s before ours must be
# ours. Older tokens (an earlier claim of the same issue, aborted or merged) do not count, whatever the local clock says.
first="$(gh issue view "$n" --json comments --jq "
  [.comments[] | select(.body | startswith(\"claim-token: \")) | select(.body | contains(\" released\") | not)] as \$c
  | (\$c[] | select(.body == \"claim-token: $token ($me)\") | .createdAt | fromdateiso8601) as \$mine
  | [\$c[] | select((.createdAt | fromdateiso8601) >= (\$mine - 90))][0].body // \"\"")"
if [[ "$first" != "claim-token: $token ($me)" ]]; then
  gh issue comment "$n" --body "claim-token: $token released (lost the race to: $first)" >/dev/null || true
  winner="$(printf '%s' "$first" | sed -nE 's/.*[(]([^)]+)[)]$/\1/p')"
  if [[ -n "$winner" && "$winner" != "$me" ]]; then gh issue edit "$n" --remove-assignee "$me" >/dev/null || true; fi
  echo "claim-issue: #$n was claimed concurrently ($first) — backing off. Pick another issue." >&2; exit 1
fi
echo "claimed #$n ($title) for $me — label in-progress, token $token. Next: git switch -c feat/$n-<slug> origin/main"
