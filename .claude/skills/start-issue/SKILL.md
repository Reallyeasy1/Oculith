---
name: start-issue
description: Start work on GitHub issue N — read it, branch feat/N-slug, restate acceptance criteria as a test plan, and map the work onto the real seams in this codebase before writing code. Usage: /start-issue 4
disable-model-invocation: true
---

Argument: an issue number (e.g. `/start-issue 4`). If missing, run `gh issue list --label P0 --state open` and ask which one.

## Steps
1. `gh issue view $ARGUMENTS --json number,title,body,labels,milestone` — read the whole body, especially **Acceptance criteria** and **Out of scope**.
2. **Assign it to yourself first, then branch.** `bash scripts/dev/claim-issue.sh $ARGUMENTS` makes you the assignee, labels the issue `in-progress` and posts a claim token; it refuses closed/claimed issues, issues assigned to someone else, and issues that already have a branch on origin (switch to that branch and stop here). The guard hook will not create `feat/$ARGUMENTS-*` until the issue is claimed by you — so do not skip this step. Then `git fetch origin && git switch -c feat/$ARGUMENTS-<slug> origin/main` (slug = 2–4 words from the title; `chore/` for non-feature issues). The hook records this session as the branch owner; other sessions cannot commit to it. If the issue depends on an unmerged parent issue, branch from that issue's branch instead and pass it later as `/finish-issue N --base <parent-branch>`.
3. Restate the acceptance criteria as a numbered **test plan**: each checkbox becomes a test name (vitest) or a manual verification step. Anything untestable → say so and propose the closest automated proxy.
4. Map to seams — name the exact files you will touch, using CLAUDE.md's architecture section: `types.ts` (contracts), `app.ts` (routes + zod), `agent-service.ts` (Run lifecycle), `codex-runner.ts` / `container-codex-runner.ts` (Runtime boundary, env allow-lists), `store.ts` (persistence), `apps/web/src/App.tsx` + `types.ts` (UI, mirrored types), `apps/server/src/glassbox/` (context, emitter, schema, redact, store, query). Adapters in the seams call the emitter only.
5. State dependencies on other issues (by number) and whether they are merged on `origin/main`.
6. Present the plan (≤ 20 lines) and wait for a go — unless the user said "just do it", in which case start with the failing tests (`negative-test-writer` for denial paths) and implement to green.

Commit messages end with `Refs #N`; the final commit for the issue uses `Closes #N`. Run `npm run check` before claiming done; ask `baseline-verifier` to confirm nothing regressed.
