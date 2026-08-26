---
name: finish-issue
description: Finish GitHub issue N — verify (npm run check), push the issue branch, and open its pull request with "Closes #N". One issue = one branch = one PR. Usage: /finish-issue 27 [--base feat/23-emitter]
disable-model-invocation: true
---

Argument: the issue number (`/finish-issue 27`). Optional `--base <branch>` when this issue's branch is stacked on another unmerged issue branch (dependent work); default base is `main`.

## Steps
1. Confirm you are on the issue's branch: `git branch --show-current` must match `feat/<N>-*` (or `chore/<N>-*`). If not, stop and say which branch you're on.
2. Confirm the branch is clean (`git status --short` empty) and every commit references the issue (`git log --format=%B origin/<base>..HEAD` — subjects or trailers contain `#N`; `<base>` is `main` or the `--base` branch). Amend nothing and add no empty commits: a missing reference is fixed by `Closes #N` in the PR body (step 5), which is what actually closes the issue.
3. Verify: `npm run check`. On Windows the documented `container-codex-runner.test.ts` `/tmp` assertion is the only allowed failure; anything else blocks the PR — fix it first.
4. Push: `git push -u origin HEAD`.
5. Open the PR (non-draft) with `gh`:
   ```bash
   gh pr create --base <base> --head "$(git branch --show-current)" \
     --title "<type>(scope): <what> (#N)" \
     --body "$(printf '%s\n' "Closes #N" "" "## What" "<2–4 bullets: behaviour added, seams touched>" "" "## Evidence" "- npm run check: <summary line>" "- Tests: <file(s)> <count>" "" "## Notes" "- Stacked on <base> (merge that first)" "- Deviations/rulings: <or 'none'>" "" "🤖 Generated with [Claude Code](https://claude.com/claude-code)" "" "<current session URL>")"
   ```
   Drop the "Stacked on" line when the base is `main`; the last line is this session's `https://claude.ai/code/session_…` URL (omit if unknown).
   Use `Refs #N` instead of `Closes #N` when the PR completes only part of the issue.
6. Print the PR URL. Do not merge; merging is the user's call. If the issue's branch was stacked, remind the user to merge in order — GitHub retargets the next PR to `main` automatically when the base branch is deleted after merge.

## Rules
- Never push `main` directly; never force-push a branch that has an open PR.
- Secrets: the commit hook already scans staged diffs; the PR body must not contain keys or `.env` values.
- One PR per issue. If a branch accidentally holds two issues' work, split it before opening PRs (cherry-pick into two branches) rather than opening one PR that closes both.
