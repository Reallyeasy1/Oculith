# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Volc Agent Launchpad" — a single-user hackathon starter kit: a React Playground + Fastify control plane that runs OpenAI **Codex CLI** (pinned `@openai/codex@0.111.0`) against the **Volcengine Ark** Responses API. Hackathon teams are expected to add exactly one middleware track (Glass Box = tracing, Bouncer = identity/authz, Kill Switch = sandboxing) on top of the existing seams — not rebuild the UI, control plane, or runtime. See `docs/HACKATHON_EXTENSION_GUIDE.md` for the acceptance checklist.

## Commands

npm workspaces monorepo (`apps/server` = `@launchpad/server`, `apps/web` = `@launchpad/web`). Node 22+.

```bash
npm install
cp .env.example .env            # loaded by the server dev script via --env-file-if-exists; Compose uses env_file
npm run dev                     # server (tsx watch, :3000) + web (vite, :5173, proxies /api → :3000)
npm run check                   # typecheck + test + build — run before claiming done
npm run typecheck               # tsc across both workspaces
npm run test                    # vitest, server only (web has no tests)
npm run build                   # web first, then server → apps/*/dist
npm run poc                     # scripts/start-local-poc.sh: bash-only, builds runtime image, RUNTIME_PROVIDER=container
```

Single test file / single test (run from repo root):

```bash
npm run test -w @launchpad/server -- src/store.test.ts
npm run test -w @launchpad/server -- src/agent-service.test.ts -t "creates, updates"
```

Other validation from CONTRIBUTING: `terraform fmt -check -recursive deploy/volcengine`, `docker compose config`.

Local dev outside Docker needs `codex` on PATH (`npm install --global @openai/codex@0.111.0`). The shell scripts in `scripts/` are bash; on Windows run them from Git Bash.

**Windows caveat:** `npm run check` fails on 2 of 12 tests that are platform artifacts, not bugs — `container-codex-runner.test.ts` expects POSIX paths but `path.resolve("/tmp/...")` yields `C:\tmp\...`, and `app.test.ts` can exceed vitest's 5s default on a cold first import (passes with `--testTimeout=30000`). Typecheck, the other 10 tests, and `build` pass on Windows; treat the suite as authoritative only on Linux/macOS (where CI/Docker run it).

Running the judged Docker path (`npm run poc`) on Windows: npm hands scripts to `cmd.exe`, and Git Bash mangles `dst=/workspace` mount paths, so invoke it as
`MSYS_NO_PATHCONV=1 LOCAL_POC_DATA_ROOT="C:/<abs>/Oculith/.local" bash scripts/start-local-poc.sh` (with `ARK_*` exported, e.g. `set -a; . ./.env; set +a`). Verified 2026-08-26: baseline acceptance task completes in ~70 s in a disposable container. The script falls back to `CODEX_SANDBOX_MODE=danger-full-access` inside the container because Docker Desktop's kernel lacks Landlock — expected, documented in `.env.example`.

Also on Windows: Codex runs every `shell_command` via `powershell.exe -Command` **with the user profile loaded** (no `-NoProfile` option exists in Codex). A slow profile (e.g. a conda init hook, ~20–40 s) is paid on *every* tool call, so multi-step runs hit `CODEX_TIMEOUT_MS`. Fix is in the profile, not the app: guard slow hooks with `if (-not [Console]::IsOutputRedirected) { ... }`. `CODEX_BIN` must also point at the native `codex.exe` (the npm `.cmd` shim can't be spawned by `execFile`).

## Architecture

Request flow: `App.tsx` → `api.ts` (bearer token in memory) → Fastify routes in `app.ts` → `AgentService` → `JsonStore` + `WorkspaceManager` + an `AgentRunner`. Wiring happens once in `apps/server/src/index.ts`.

**Runs are asynchronous.** `POST /api/agents/:id/messages` atomically flips the Agent to `busy`, inserts a `queued` Run + user Message, fires `executeRun` in the background, and returns immediately. The web UI polls `GET /api/runs/:id`. Run terminal states: `completed | failed | cancelled`; Agent states: `ready | busy | stopped | error`. On startup `AgentService.initialize()` marks any `queued`/`running` Run as `cancelled` and resets `busy` Agents. One active Run per Agent is enforced in the store mutation, not in the route.

**`AgentRunner` is the extension seam** (`types.ts`): `run(request) → {output, threadId, usage}`, `cancel(agentId)`, `isAvailable()`. `runner-factory.ts` picks by `RUNTIME_PROVIDER`:
- `local-process` → `CodexRunner`: spawns `codex exec --json --sandbox <mode> --skip-git-repo-check -C <workspace> [resume <threadId>] <prompt>` as a child process. Used in Docker Compose / ECS where Codex lives in the app container.
- `container` → `ContainerCodexRunner`: same argv, but wrapped in `docker|podman run --rm` with cap-drop/no-new-privileges/cpu/mem/pids limits, workspace bind-mounted at `/workspace` and `CODEX_HOME` at `/codex-home`. Container is named `launchpad-<instanceId>-<agentId>`; cancel = `rm --force` that name. Used by `npm run poc`.

Both runners share `buildCodexArgs` and `parseCodexEventLine` (exported from `codex-runner.ts`). Codex output is JSONL; the parser only cares about `thread.started` (thread id), `item.completed` with `agent_message` (the reply = **last** agent message), `turn.completed` (usage), and `error`. Both runners cap output bytes (`CODEX_MAX_OUTPUT_BYTES`), time out (`CODEX_TIMEOUT_MS`), pass a minimal allow-listed env (only `ARK_API_KEY` + a few inherited vars), and escalate SIGTERM→SIGKILL after 3s.

**Multi-turn memory is Codex's own thread.** `Agent.codexThreadId` is stored after the first turn; later turns pass `resume <threadId>`. Codex sessions live under `CODEX_HOME`, whose `config.toml` is regenerated from env on every boot by `writeCodexConfig` (don't edit that file by hand).

**Persistence:** `JsonStore` holds the whole `Database` (`agents`, `messages`, `runs`) in memory and serialises `mutate()` calls through a promise queue, writing `launchpad.json` atomically via tmp+rename. `snapshot()` returns a `structuredClone` — reads are cheap, but there is no cross-process safety. Each Agent gets a workspace dir at `AGENT_WORKSPACE_ROOT/<agentId>` containing a platform-generated `AGENTS.md` (Codex reads this as its instructions; rewritten on every Agent update), `README.md`, `.gitignore`. Delete = move to `workspaces/.deleted/<id>-<timestamp>`.

**Auth:** an `onRequest` hook in `app.ts` requires `Bearer $APP_AUTH_TOKEN` on `/api/*` except `/api/health` and `/api/auth`, only when the token is set. `loadConfig` refuses to start a non-loopback production server with a token <24 chars. This is a shared demo secret, not identity — the Bouncer track is about replacing it.

**Config:** all env parsing is one zod schema in `config.ts`; `AppConfig` is its return type. `MODEL_PROVIDER=ark|openai` selects which block `codexConfigToml` writes into Codex's `config.toml` (`ark` = custom `volcengine_ark` provider over the Responses API, `openai` = Codex's built-in provider reading `OPENAI_API_KEY`); API keys reach Codex only via env allow-lists, never argv. Add new settings there and mirror them in `.env.example` (CONTRIBUTING requires it). Errors thrown as `HttpError(status, msg)` map straight to responses; `ZodError` → 400 with `details`.

**Web:** single `App.tsx` (~670 lines) + `styles.css`; `apps/web/src/types.ts` duplicates the server's public types by hand — keep them in sync when changing `Agent`/`AgentRun`/`Message`. In production the server serves `apps/web/dist` with an SPA fallback; in dev CORS is opened for `localhost:5173`.

## The project: GlassBox (Track 1 middleware)

This repo is the team's TechJam 2026 Track 1 submission. The middleware being built is **GlassBox** — an observation plane: every Run becomes one correlated, privacy-safe trace (`ObservationEvent` contract → redaction → NDJSON `TraceStore` → query/rollup → Runs list + Trace detail with first-failure focus), plus a gated deterministic failure fixture for the demo. Orchestration/controls are roadmap only. Spec: `docs/PRD.md` (v2; superseded the LaunchGuard v1). Work is tracked as GitHub issues #21–#41 under epic #42 (milestones = the six build days).

Governing rule: **ship evidence before control.** Never cut redaction, real backend instrumentation, the controlled failure, baseline regression, or the trace-detail path; cut streaming/export/charts first. Trust invariants live in `.claude/rules/glassbox-invariants.md` and are not negotiable. New server code goes in `apps/server/src/glassbox/` (context, emitter, redact, store, query); adapters stay in the existing seams.

## Claude Code setup in this repo (`.claude/`)

- **Hooks** (`settings.json` → `hooks/*.cjs`, Node so they run on Windows and Linux): block edits to `.env*`, lockfiles, runtime state and pristine fixtures; block force-push/`--no-verify`/destructive git/`cat .env`; scan staged diffs for API keys and canaries before every `git commit`; typecheck the touched workspace after every TS edit; print branch + open P0 issues at session start.
- **Rules** (`rules/`): path-scoped conventions for server, web, and the GlassBox invariants.
- **Agents** (`agents/`): `glassbox-privacy-reviewer` (adversarial, read-only — run before merging anything that emits, stores, or renders trace data), `negative-test-writer` (table-driven privacy/degradation/rollup tests for AC-02..06), `baseline-verifier` (starter-kit acceptance flow over the API + trace endpoints + `npm run check`).
- **Skills**: `/start-issue N` (branch + test plan mapped to seams), `/run-poc` (judged Docker path with the Windows quirks handled).
- **MCP** (`.mcp.json`): `context7` for Fastify/Vite/Codex docs, `playwright` for driving the UI in E2E checks and demo screenshots.
- Permissions pre-allow read-only git/gh/npm-check commands and deny reading `.env`, `.local/`, `codex-home/`.

Workflow per issue: `/start-issue N` → failing tests → implement → `npm run check` → security review if under the invariants rule → commit `Refs #N` / `Closes #N` → push.

## Conventions worth knowing

- Server TS is strict with `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` — optional fields are typed `x?: T | undefined` deliberately.
- ESM throughout; server imports use `.js` extensions (`./store.js`) even for `.ts` sources.
- Tests are colocated `*.test.ts`, excluded from `tsc` build via server `tsconfig.json`. Service tests build a real `AgentService` on a `mkdtemp` dir with a `FakeRunner` implementing `AgentRunner` — follow that pattern rather than mocking modules.
- Never inherit the full `process.env` into child processes/containers; extend the explicit allow-lists in the runners' `childEnvironment()`.
