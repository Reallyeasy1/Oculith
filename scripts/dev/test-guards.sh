#!/usr/bin/env bash
# Self-check for .claude/hooks/guard-bash.cjs parallel-work rules: runs the hook against a throwaway repo with two
# fake sessions and a fake `gh` on PATH (so the claim check is exercised without the network). Exit 0 = all hold.
set -euo pipefail
here="$(cd "$(dirname "$0")/../.." && pwd)"
hook="$here/.claude/hooks/guard-bash.cjs"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
git -C "$tmp" init -q -b main
# Fake gh (node script, wired through OCULITH_GH_BIN so no shell is involved): issue 1 is claimed by "me" with
# in-progress; issue 2 is open and unclaimed; no open PRs.
cat > "$tmp/fake-gh.js" <<'JS'
const a = process.argv.slice(2).join(" ");
const out = (s) => { process.stdout.write(s + String.fromCharCode(10)); process.exit(0); };
if (a === "api user --jq .login") out("me");
if (a === "issue view 1 --json labels,assignees,state") out('{"state":"OPEN","labels":[{"name":"in-progress"}],"assignees":[{"login":"me"}]}');
if (a === "issue view 2 --json labels,assignees,state") out('{"state":"OPEN","labels":[],"assignees":[]}');
if (a.startsWith("pr list --state open --head ")) out("[]");
process.stderr.write("fake gh: unhandled: " + a + String.fromCharCode(10)); process.exit(1);
JS
export OCULITH_GH_BIN="$tmp/fake-gh.js"
run() { # session command -> prints exit code
  local session=$1 command=$2
  node -e '
    const [s,c,d]=process.argv.slice(1);
    process.stdout.write(JSON.stringify({session_id:s,cwd:d,tool_input:{command:c}}));' "$session" "$command" "$tmp" | node "$hook" >/dev/null 2>"$tmp/err" && echo 0 || echo $?
}
expect() { local want=$1 got=$2 what=$3; if [[ "$got" == "$want" ]]; then echo "ok   $what"; else echo "FAIL $what (exit $got, wanted $want): $(cat "$tmp/err")"; exit 1; fi; }

# Claims
expect 2 "$(run A 'git switch -c feat/2-thing origin/main')" "branch for an unclaimed issue is blocked (assign yourself first)"
expect 0 "$(run A 'bash scripts/dev/claim-issue.sh 2')" "session A may claim issue 2 locally"
expect 2 "$(run B 'bash scripts/dev/claim-issue.sh 2')" "session B may not claim issue 2 on the same machine"
expect 0 "$(run A 'git switch -c feat/1-thing origin/main')" "branch for a claimed issue (label + assignee) is allowed"
git -C "$tmp" switch -q -c feat/1-thing
expect 2 "$(run B 'git checkout -b feat/1-other origin/main')" "second branch for an issue claimed by another session is blocked"
expect 0 "$(run A 'OCULITH_CLAIM_OVERRIDE=1 git switch -c feat/2-offline origin/main')" "claim override works offline"
# Ownership
expect 0 "$(run A 'git commit -m x -- file')" "owner may commit"
expect 2 "$(run B 'git commit -m x -- file')" "other session may not commit on an owned branch"
expect 2 "$(run B 'git push -u origin HEAD')" "other session may not push via HEAD"
expect 2 "$(run B 'git push origin HEAD:feat/1-thing')" "other session may not push via HEAD:branch"
expect 2 "$(run B 'git -C . commit -m x -- file')" "git -C prefix does not bypass ownership"
expect 0 "$(run B 'OCULITH_OWNER_OVERRIDE=1 git commit -m x -- file')" "controller override is honoured"
expect 2 "$(run B 'git switch -c feat/1-thing')" "other session may not recreate an owned branch"
expect 2 "$(run B 'git commit -m \"OCULITH_OWNER_OVERRIDE=1 in a message\" -- file')" "override token inside the command text does not count"
expect 2 "$(run B 'echo OCULITH_OWNER_OVERRIDE=1; git commit -m x -- file')" "override token in an earlier statement does not count"
git -C "$tmp" switch -q -c chore/9-unowned
expect 0 "$(run B 'git commit -m x -- file')" "first touch of an ownerless branch claims it"
expect 2 "$(run A 'git commit -m x -- file')" "…and the previous session is now excluded"
# Merge discipline
expect 2 "$(run A 'git push origin --delete feat/1-thing')" "manual remote branch delete is blocked"
expect 2 "$(run A 'git push origin :feat/1-thing')" "refspec delete is blocked"
expect 0 "$(run A 'bash scripts/dev/merge-prs.sh 12')" "merge script is allowed"
expect 2 "$(run A 'gh pr merge 12 --merge')" "manual gh pr merge is blocked"
expect 2 "$(run A 'gh api repos/x/y/pulls/12/merge -X PUT')" "gh api merge is blocked"
expect 2 "$(run A 'git push --force origin feat/1-thing')" "force push is blocked"
expect 2 "$(run A 'git push origin +feat/1-thing')" "plus-refspec force push is blocked"
expect 2 "$(run A 'git push origin main')" "push to main is blocked"
expect 2 "$(run A 'git push -u origin HEAD:main')" "push HEAD:main is blocked"
expect 0 "$(run A 'git push -u origin feat/1-thing-main')" "branch names containing 'main' are not blocked"
expect 0 "$(run A 'gh pr create --base main --head feat/1-thing --title t --body b')" "first PR for a branch is allowed"
echo "guard-bash: all parallel-work rules hold"
