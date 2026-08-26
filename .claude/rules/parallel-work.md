# Parallel work: claim the issue, own the branch, merge through the script

Several Claude sessions, subagents and teammates work on this repo at once. These rules make the races that bit us
(two sessions in one working tree, a stacked PR closed by a branch deletion, the same fix applied twice) mechanically
impossible where a hook can enforce them, and explicit where it cannot.

## The order of operations for any issue
1. **Assign it to yourself first:** `bash scripts/dev/claim-issue.sh N`. It sets you as assignee, labels the issue
   `in-progress`, posts a `claim-token` comment, and backs off if someone else's token won the same round trip. It
   refuses closed or already-claimed issues and issues that already have a `feat|fix|chore/N-*` branch on origin.
2. **Then branch:** `git switch -c feat/N-<slug> origin/main`. The hook refuses to create any `feat|fix|chore/N-*`
   branch unless issue N is `in-progress` **and** assigned to the current `gh` user, and unless no other session on
   this machine holds N. There is no "I'll claim it after" — the branch does not get created.
3. Work only on that branch. `git commit` / `git push` on a branch another session created (or first committed to) are
   blocked. A controller folding a review follow-up onto a *finished* agent branch prefixes `OCULITH_OWNER_OVERRIDE=1`.
4. **PR via `/finish-issue N`** — one PR per branch (a second `gh pr create` for the same head is blocked); the issue
   flips to `in-review`.
5. **Merge only via `bash scripts/dev/merge-prs.sh <pr…>`** in stack order: requires a `## Review — Mergeable…`
   comment, merges with a merge commit, retargets dependent PRs to `main` **before** deleting the head branch, clears
   the claim labels. Manual `gh pr merge`, `gh api …/merge`, `git push --delete`, `:branch`, force pushes and pushes
   to `main` are blocked.

## What the hook cannot see (controller discipline)
- **Agents run in worktrees (`.claude/worktrees/`); the main working tree belongs to the controller.** Never dispatch
  a fixer into the main tree while other agents run; never run two agents on one branch.
- **One claim per agent.** When dispatching, the controller claims the issue (the assignee is the team account) and the
  agent's own session becomes the local owner when it creates the branch; a second agent for the same issue is refused
  by the hook. Disjoint file sets per parallel brief; anything that must touch the same file is sequential.
- **Conflicts:** merge `main` into the branch; never rebase or force-push a branch with an open PR.
- **Shared instance and lane:** restarting the :3000 POC, rebuilding `dist/`, or running the E2E lane are controller
  actions (the lane uses :3100 and its own state root; killing a server's wrapper shell orphans it).
- **Stale claims:** if an `in-progress` issue shows no branch activity for a day, the controller releases it
  (`bash scripts/dev/release-issue.sh N --abort`) and says so on the issue.

## Keeping the guards honest
`npm run check` runs `scripts/dev/test-guards.sh` (28 cases against a throwaway repo with two fake sessions and a fake
`gh`); a change to `guard-bash.cjs` that weakens a rule fails the build. Add a case whenever you add a rule.

## Escapes (write down why when you use one)
`OCULITH_CLAIM_OVERRIDE=1` (offline, cannot reach GitHub) · `OCULITH_OWNER_OVERRIDE=1` (controller takeover of a
finished branch) · `merge-prs.sh --no-review-gate` (never for a code PR).
