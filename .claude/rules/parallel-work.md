# Parallel work: one issue = one branch = one worktree = one session

Several Claude sessions and subagents work on this repo at once. These rules make the races that bit us
(two sessions in one working tree, a stacked PR closed by a branch deletion, the same fix applied twice)
mechanically impossible where a hook can enforce them, and explicit where it cannot.

## Enforced by hooks and scripts
- **Claim before you branch.** `bash scripts/dev/claim-issue.sh N` assigns you and labels the issue `in-progress`. It refuses closed or already-claimed issues and issues that already have a `feat|fix|chore/N-*` branch on origin — continue on that branch instead of starting a second one. `/start-issue` runs it.
- **The session that creates a branch owns it.** `git switch -c` / `checkout -b` records `branch → session` in the shared `.git` dir; `git commit` and `git push` on a branch owned by another session are blocked. A controller taking over a *finished* agent branch (folding a review follow-up) prefixes the command with `OCULITH_OWNER_OVERRIDE=1` — never while that agent is still running.
- **One PR per branch.** `gh pr create` is blocked when the head already has an open PR. `/finish-issue` opens the PR and flips the issue to `in-review`.
- **Merges only through `bash scripts/dev/merge-prs.sh <pr…>`**, in stack order. It requires a `## Review —` comment, merges with a merge commit, **retargets dependent PRs to `main` before deleting the head branch** (a plain `git push --delete` closes them — the hook blocks it), and clears the claim labels. Manual `gh pr merge`, `git push --delete`, force pushes and pushes to `main` are blocked.
- **Session start lists what is taken:** claimed issues, open PRs, active worktrees, branch owners. Read it before dispatching.

## Enforced by the controller (no hook can see it)
- **Agents run in worktrees (`.claude/worktrees/`), the main working tree belongs to the controller.** Never dispatch a fixer into the main tree while other agents are running; never run two agents on one branch.
- **Disjoint file sets per parallel brief.** Two agents that must touch the same file are sequential (stack the second branch on the first) or one agent.
- **Conflicts are resolved by merging `main` into the branch**, never by rebasing or force-pushing a branch that has an open PR.
- **Restarting the shared POC instance on :3000, rebuilding `dist/`, or running the E2E lane are controller-only actions** (the lane uses :3100 and its own state root; the instance's wrapper shell must not be killed — an orphaned server cannot spawn Docker).
- **Stale worktrees:** remove them after merge (`git worktree remove --force`, then delete the local branch). A worktree directory held open by a stray process is harmless but must not be reused.

## When something is already taken
Do not "help" on a claimed issue or an owned branch. Report to the controller, take the next unclaimed issue, or wait for the PR. If a claim looks abandoned (>24 h, no branch activity), the controller releases it with `bash scripts/dev/release-issue.sh N --abort` and says so on the issue.
