#!/usr/bin/env bash
# Self-check for .claude/hooks/guard-bash.cjs parallel-work rules: runs the hook against a throwaway repo with
# two fake sessions. Exit 0 = all rules hold. No network (gh checks are skipped via OCULITH_GUARD_SKIP_GH).
set -euo pipefail
here="$(cd "$(dirname "$0")/../.." && pwd)"
hook="$here/.claude/hooks/guard-bash.cjs"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
git -C "$tmp" init -q -b main
export OCULITH_GUARD_SKIP_GH=1
run() { # session command -> prints exit code
  local session=$1 command=$2
  node -e '
    const [s,c,d]=process.argv.slice(1);
    process.stdout.write(JSON.stringify({session_id:s,cwd:d,tool_input:{command:c}}));' "$session" "$command" "$tmp" | node "$hook" >/dev/null 2>"$tmp/err" && echo 0 || echo $?
}
expect() { local want=$1 got=$2 what=$3; if [[ "$got" == "$want" ]]; then echo "ok   $what"; else echo "FAIL $what (exit $got, wanted $want): $(cat "$tmp/err")"; exit 1; fi; }

expect 0 "$(run A 'git switch -c feat/1-thing origin/main')" "session A creates feat/1-thing"
git -C "$tmp" switch -q -c feat/1-thing
expect 0 "$(run A 'git commit -m x -- file')" "owner may commit"
expect 2 "$(run B 'git commit -m x -- file')" "other session may not commit on an owned branch"
expect 2 "$(run B 'git push -u origin feat/1-thing')" "other session may not push an owned branch"
expect 0 "$(run B 'OCULITH_OWNER_OVERRIDE=1 git commit -m x -- file')" "controller override is honoured"
expect 2 "$(run B 'git switch -c feat/1-thing')" "other session may not recreate an owned branch"
expect 2 "$(run A 'git push origin --delete feat/1-thing')" "manual remote branch delete is blocked"
expect 2 "$(run A 'git push origin :feat/1-thing')" "refspec delete is blocked"
expect 0 "$(run A 'bash scripts/dev/merge-prs.sh 12')" "merge script is allowed"
expect 2 "$(run A 'gh pr merge 12 --merge')" "manual gh pr merge is blocked"
expect 2 "$(run A 'git push --force origin feat/1-thing')" "force push is blocked"
expect 0 "$(run A 'git push -u origin feat/1-thing')" "owner may push"
echo "guard-bash: all parallel-work rules hold"
