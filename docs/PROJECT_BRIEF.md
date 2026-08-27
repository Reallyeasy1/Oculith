# GlassBox project reference

_State as of 27 August 2026 (main `755546b`). Sections 1–9 describe the system and change slowly; sections 10–14 (plan, status, ledger, UAT history, risks) are snapshots — epic #42, `docs/SPRINTS.md` and the GitHub milestone **TechJam MVP** are the live source of truth._

---

## Contents

1. [What it is](#1-what-it-is)
2. [Problem, concept, users, non-goals](#2-problem-concept-users-non-goals)
3. [Architecture](#3-architecture)
4. [Observation contract](#4-observation-contract)
5. [Data flow of one Run](#5-data-flow-of-one-run)
6. [Query, rollups and derived views](#6-query-rollups-and-derived-views)
7. [Verify: cases, evaluators, eval Runs, comparison](#7-verify-cases-evaluators-eval-runs-comparison)
8. [API reference](#8-api-reference)
9. [Configuration, runbook and verification](#9-configuration-runbook-and-verification)
10. [Sprint plan and critical path](#10-sprint-plan-and-critical-path)
11. [Status board](#11-status-board)
12. [Issue and PR ledger](#12-issue-and-pr-ledger)
13. [UAT history and findings](#13-uat-history-and-findings)
14. [Working agreements, decisions, risks](#14-working-agreements-decisions-risks)
15. [Glossary and links](#15-glossary-and-links)

---

## 1. What it is

**GlassBox** is an agent-reliability middleware built on the Volc Agent Launchpad starter kit for TikTok TechJam 2026, Track 1. It sits between the control plane and the runtime of an AI coding agent (Codex CLI in a disposable container) and answers, with evidence rather than inference:

> _What did the agent do? Why did it fail? Did a configuration change make it worse?_

| Stage | What it means | State |
|---|---|---|
| **Instrument** | Every layer emits one versioned `ObservationEvent` contract: HTTP ingress → AgentService → runner → container → Codex stream → workspace | merged |
| **Observe** | Per-Run trace tree with rollups, first-actionable failure and diagnosis, per-Run metrics, capability states, redaction before persistence | merged |
| **Audit** | Actor / action / resource / outcome rows projected from stored events; sandbox denials as first-class evidence | merged |
| **Verify** | Save a Run as a Regression Case, rerun it from the same starting state under a new configuration, flag PASS→FAIL as `REGRESSION` | in review (PR stack #106 → #144) |

**History.** The repository started as _LaunchGuard_ (capability leases and a protected-action gateway; issues #1–#20, all closed). On 26 August it was re-scoped to GlassBox (epic #42): evidence, not control, is what the track rewards, and a future controller needs the same facts anyway (PRD goal G6 — the contract must drive future controls without re-instrumenting). Sprint 1 (Observe) shipped the same day; the Verify half was planned as sprints S1–S8 (section 10).

## 2. Problem, concept, users, non-goals

**Problem.** Agent Runs fail silently or opaquely. A timeout, a sandbox denial, a runtime crash, a model that gives up, and a platform degradation all look the same from the outside — a Run that "did not work". Nothing links a prompt or configuration change to a behavioural regression.

**Concept.** Observability-first middleware. Facts are captured once, at the seams the platform already owns (HTTP boundary, `AgentService`, `AgentRunner`, the Codex JSON stream, the workspace), and every product surface — trace, audit, metrics, evaluators, comparison — is a projection of the same stored events. There is no second source of runtime truth and nothing is inferred that the events do not say.

**Goals (PRD §3).**

| # | Goal | How we know |
|---|---|---|
| G1 | Every real Run correlates into one trace with stable `traceId / spanId / runId / agentId / sessionId / requestId / actorId / sequence` | 100 % of demo Runs create a trace with a terminal status |
| G2 | Hierarchy, status, timing, errors, cancellation, retries, runtime/container metadata and usage are visible when available | AC-01: success trace shows ingress → service → runner → runtime → workspace → terminal |
| G3 | Operator finds the first actionable failure fast | AC-02: ≤ 2 interactions and ≤ 10 s from Runs list to the failing span |
| G4 | Secrets never reach any observation surface | AC-03: seeded fakes absent from NDJSON, API, UI, export, logs |
| G5 | Baseline preserved | AC-07: starter-kit acceptance flow passes; `npm run check` green |
| G6 | Contract can drive future controls without re-instrumenting | emitters never import UI; `TraceStore` is an interface |

**Users.** Agent developer/operator (primary) · platform maintainer · hackathon evaluator · a future controller that consumes the facts.

**Non-goals (MVP).** Capturing chain-of-thought or full prompts/completions (`full/raw` capture is prohibited, not merely off) · replacing Jaeger/Grafana/Datadog/OTel Collector · multi-tenancy, enterprise identity, hardened authz · scheduler, workflow engine, router, A2A gateway, reconciliation controller · requiring ECS/cloud (the local POC is the judged path) · guaranteeing model/tool-level events when the runtime does not expose them · LLM judges, probabilistic scores, trace replay, cross-model tournaments, policy engine (Verify non-goals, PRD §16.2).

## 3. Architecture

```text
Browser (React/Vite, apps/web)
   │  polls /api/runs, /api/runs/:id/trace, /api/runs/:id/audit
   ▼
Fastify API (apps/server/src/app.ts) ── bearer auth hook (APP_AUTH_TOKEN; /api/auth exempt)
   │  trace context created at the boundary (requestId, traceId, root span)
   ▼
AgentService (agent-service.ts) ── Agents, Runs, busy rule, restart handling, workspace snapshot
   │  emits control events; passes trace ids to the runner
   ▼
AgentRunner ──► ContainerCodexRunner (docker run --rm --init --cap-drop ALL, no -p)
   │            └─ Codex CLI 0.111 `exec --json` inside volc-agent-runtime:local
   │               model: BytePlus Ark (deepseek-v4-flash) or OpenAI
   ▼
CodexObserver (glassbox/codex-observer.ts) maps the JSON stream → tool/model/policy events
   │
   ▼
ObservationEmitter (glassbox/emitter.ts) ── validate (zod) → redact (redact.ts) → sequence → append
   │  non-blocking; on store failure emits telemetry.degraded and never fails the Run
   ▼
TraceStore (glassbox/store.ts) ── one NDJSON file per Run under GLASSBOX_TRACE_DIR + rebuilt in-memory index
   │
   ▼
buildTrace / projectAudit / evaluators (glassbox/query.ts, eval/evaluators.ts) ── pure functions over stored events
```

| Component | Location | Responsibilities |
|---|---|---|
| Web UI | `apps/web/src` | `App.tsx` (bootstrap, Agent selection, polling), `RunsView.tsx` (per-Agent and All-runs tables, quick filters, Live strip, recovered chips), `Overview.tsx` (summary strip), `TraceDetail.tsx` (summary header, first-error banner with Jump, timeline axis, span tree, filters, span drawer, audit tab), `runs-view-model.ts` / `trace-view-model.ts` (pure view logic, unit-tested), `types.ts` (mirror of server shapes) |
| Fastify API | `apps/server/src/app.ts` | Routes (section 8), zod validation → 400, `HttpError` → status, auth hook, static web build in production, error handler registered before routes so validation errors are 400 in production too |
| AgentService | `apps/server/src/agent-service.ts` | Agent CRUD, `sendMessage` → `executeRun`, busy rule (409 while a Run is active), cancellation (`stopAgent` → `cancelExecution`), restart recovery in `initialize()`, workspace snapshot before/after the Run, thread persistence, `configHash`/`configSnapshot` |
| Store | `apps/server/src/store.ts` | `JsonStore`: a single `db.json` (agents, runs, messages, and — in review — regressionCases, evalRuns) mutated through a serial `mutate()` queue |
| Runtime providers | `apps/server/src/codex-runner.ts`, `container-codex-runner.ts` | `local-process` (Codex on the host) and `container` (default): argv built without secrets, API key passed via env, output cap `CODEX_MAX_OUTPUT_BYTES`, timeout `CODEX_TIMEOUT_MS`, exit code and signal observed and reported, `GLASSBOX_DEMO_FAILURE=timeout` gates a deterministic 3 s timeout fixture |
| Workspaces | `apps/server/src/workspace.ts` | `WorkspaceManager`: per-Agent directory under `AGENT_WORKSPACE_ROOT`, platform-owned `AGENTS.md` (sandbox briefing, refreshed at boot), `.gitignore`/`README.md`; named shared workspaces and templates (PRs #106/#123) |
| Workspace snapshot | `apps/server/src/workspace-snapshot.ts` | Bounded tree hash (5 000 entries, 4 MiB hashed per file, 200 paths reported) before and after a Run → `workspace.changed` |
| Post-check | `apps/server/src/postcheck-runner.ts` (#114) | Runs a verification command inside the sandbox against a Run's workspace; emits `runtime.postcheck.*` |
| Evaluators | `apps/server/src/eval/evaluators.ts` (#122) | Deterministic assertions over a trace (section 7) |
| GlassBox core | `apps/server/src/glassbox/` | `schema.ts`, `emitter.ts`, `redact.ts`, `store.ts`, `query.ts`, `codex-observer.ts`, `context.ts`, `otlp.ts` (mapping adapter, #107) |
| Runtime image | `runtime/` + `Dockerfile` | `volc-agent-runtime:local` built by the POC script; contains Node, Codex CLI, `agentctl`; no `curl` (observed in UAT round 3) |

**Invariants** (`.claude/rules/glassbox-invariants.md`, enforced by review):

1. **Redact before persist, fail closed.** Every event passes `redactEvent` before append; if redaction throws, `failClosed` replaces the payload. Seeded fake Ark/OpenAI/bearer/private-key fixtures are swept from NDJSON files, API, UI DOM, export and logs in the E2E lane.
2. **Never fabricate evidence.** Absence is `unknown`, not `unavailable`; incomplete spans stay `incomplete`; restart-cancels are labelled `server_restart`; audit rows and evaluator results always reference source events.
3. **Telemetry is non-blocking.** A broken trace store yields `telemetry.degraded` and a `degraded` flag; the Run's real result is unaffected.
4. **Baseline preserved.** The starter kit's acceptance flow and `npm run check` stay green; Agent CRUD keeps working.
5. **Versioned, additive contract.** `SCHEMA_VERSION` is `"1.0"`; new event types and attributes are added without bumping it, because `readRun` skips lines whose version differs and a bump would make every stored trace unreadable.

## 4. Observation contract

Defined with zod in `apps/server/src/glassbox/schema.ts` (`SCHEMA_VERSION "1.0"`, `REDACTION_RULESET_VERSION "1"`).

**Identity and ordering.** `eventId` (unique; duplicates are dropped on read), `sequence` (monotonic per Run, assigned by the emitter), `timestamp` (ISO), `traceId`, `runId`, `agentId`, `sessionId?` (Codex thread), `requestId?`, `spanId`, `parentSpanId?`.

**Vocabulary.**

| Field | Values |
|---|---|
| `status` | `running`, `ok`, `error`, `cancelled`, `timeout`, `unset` |
| `category` | `experience`, `control`, `runtime`, `model`, `tool`, `workspace`, `sandbox`, `policy`, `infrastructure` |
| `phase` | `start`, `end`, `instant` |
| `actorType` / `actorId` | `human/local-user` (requests, user cancellations), `agent/<agentId>` (tool and model actions), `service/runner` (runtime lifecycle), `service/sandbox` (denials), `service/server` (restart cancellations) |
| `capturePolicy` | `metadata_only` (default), `safe_summary` (512-character redacted command heads and summaries) |
| `source` | `{ component, adapter?, observed: boolean }` — `observed: false` marks synthesized control facts |
| `privacy` | `{ redacted: boolean, rulesetVersion, rules?, reason? }`, always derived from the redaction pass |

**Event types.**

| Family | Types | Emitted by |
|---|---|---|
| Run lifecycle | `run.created` (attributes `promptBytes`, `configHash`, eval tags), `run.started`, `run.completed` (usage totals, `outputBytes`), `run.failed`, `run.cancelled` (`cancelledBy`, `cancelRequestedAt` or `reason: server_restart`), `run.timed_out` | AgentService |
| Ingress | `http.request.received` / `http.request.completed` (`statusCode`, `method`) | Fastify hook (`context.ts`) |
| Service span | `agent_service.run.started` / `.completed` / `.failed` (`resume`) | AgentService |
| Container | `runtime.container.started` / `.stopped` (`engine`, `image`, `containerName`, `cpus`, `memory`, `pids`, `exitCode`) | ContainerCodexRunner |
| Codex process | `runtime.codex.started` / `.completed` / `.failed` (`sandbox`, `resume`, `timeoutMs`, `exitCode`, `terminationSignal`, `sessionId`, `outputBytes`, `demoFailure`) | runners |
| Post-check | `runtime.postcheck.started` / `.completed` / `.failed` | PostCheckRunner |
| Model | `model.request`, `model.completed` (`inputTokens`, `cachedInputTokens`, `outputTokens`) | CodexObserver |
| Tool | `tool.call.started`, `tool.call.completed`, `tool.call.failed` (`program`, `commandBytes`, `exitCode`, `outputBytes`; `summary.text` under `safe_summary`) | CodexObserver |
| Workspace | `workspace.changed` (`added`, `modified`, `removed`, `bytesDelta`, `truncated`, `paths`) | AgentService |
| Policy / limits | `policy.denied` (declined program, `service/sandbox`), `limit.exceeded` (output cap) | CodexObserver, runners |
| GlassBox self-events | `redaction.applied`, `error.recorded`, `telemetry.degraded`, `trace.truncated`, `capability.unavailable` | emitter, observer, store |

**Terminal mapping.** `run.completed → ok`, `run.failed → error`, `run.cancelled → cancelled`, `run.timed_out → timeout`; the last terminal event in sequence order decides the Run's trace status.

**Redaction pipeline** (`redact.ts`, applied to every event before append): allow-listed structure → key deny-list with boundary-aware matching (`aws_secret_access_key` drops, `total_tokens` survives) → pattern scan (Ark/OpenAI-style keys, bearer tokens, PEM bodies even when truncated, credentialed URLs) → truncation to bounded sizes → `privacy` block written from this pass only. Runner thread ids and span names are scanned too. Any exception → `failClosed(event)`.

**Store** (`store.ts`). One append-only file per Run: `<GLASSBOX_TRACE_DIR>/<runId>.ndjson`; an in-memory index (per-Run status, counts, last event) is rebuilt from the files at boot. Per-Run event cap: content events beyond the cap are dropped and `trace.truncated` recorded; terminal and error events are always kept. Retention (`GLASSBOX_RETENTION_DAYS`, `GLASSBOX_MAX_DISK_MB`) evicts content events by age or disk cap and leaves an eviction marker, so `evicted` Runs still show their terminal/error evidence. Duplicate `eventId`s (retried appends) never double-count.

## 5. Data flow of one Run

1. `POST /api/agents/:id/messages` — the ingress hook creates the trace context (`requestId`, `traceId`, root span `http.request.received`). The route validates the body (zod), stores the message, and calls `AgentService.sendMessage`.
2. `run.created` (instant, `configHash`, `promptBytes`) is emitted; the Agent becomes `busy` inside one `store.mutate` (409 if already busy). The HTTP request completes with 202 (`http.request.completed`), while `executeRun` continues detached.
3. `agent_service.run.started` opens the service span; `run.started` is recorded. The workspace snapshot is taken **before** the final cancellation check (a stop that arrives during the snapshot still wins — #111 follow-up).
4. The runner starts the container (`runtime.container.started`) and Codex (`runtime.codex.started` with `sandbox`, `resume`, `timeoutMs`). The API key travels through the environment, never argv.
5. `CodexObserver` reads the JSON stream line by line: `command_execution` items → `tool.call.completed|failed` (program, byte counts, exit code); `mcp_tool_call`, `web_search`, `file_change` → tool events; usage → `model.completed`; sandbox-declined commands → `policy.denied`; stream errors → `error.recorded`; a stream that never produced tool/model items → `capability.unavailable`.
6. Codex exits (`runtime.codex.completed|failed` with `exitCode`/`terminationSignal`); the container stops (`runtime.container.stopped`).
7. The workspace is snapshotted again → `workspace.changed`; `run.completed` (usage totals) or `run.failed|cancelled|timed_out`; `agent_service.run.completed|failed` closes the service span; the Agent returns to `ready` (or `stopped`).
8. Every event went through the emitter: validation → redaction → sequencing → append. If the store threw, `telemetry.degraded` was recorded in memory and the Run continued.
9. The web app polls `/api/runs` (and the open trace at 1.5 s while running, 5 s otherwise), so the Run appears in the Live strip while running and in the table with its chips when terminal.

**Cancellation.** `POST /api/agents/:id/stop` → `cancelExecution`: marks `cancelRequestedAt` on the open spans, calls `runner.cancel` (SIGKILL on the container → `exitCode 137`), awaits the execution promise, emits `run.cancelled { cancelledBy: "local-user", cancelRequestedAt }` with `human/local-user` actor.

**Restart.** `AgentService.initialize()` at boot marks every `running` Run `cancelled` ("Server restarted while this run was active"), resets `busy` Agents to `ready`, refreshes every workspace's `AGENTS.md`, and emits `run.cancelled { reason: "server_restart" }` with actor `service/server`, parented on the Run's stored service span. `buildTrace` then reports `endedReason: "server_restart"`, keeps `endedAt` at the marker but stops `durationMs` at the last event observed before the restart, and labels incomplete spans `interrupted`. Issue #136 proposes `interruptedAfterMs` and a heartbeat to tighten the bound.

## 6. Query, rollups and derived views

`buildTrace(events, { capturePolicy, degraded, truncated })` in `query.ts` is a pure function and the single rollup used by the Runs list, the trace endpoint, the export and the E2E lane.

- **Spans** are reconstructed from `start`/`end`/`instant` events (out-of-order `start` after `end` is tolerated; an `end` without `start` derives a provisional start and stays `incomplete`); parent cycles are guarded; the tree is ordered by `sequence`.
- **Summary** fields: `status`, `startedAt`, `endedAt`, `durationMs`, `endedReason`, `eventCount`, `spanCount`, `incompleteSpans`, `redactedEvents`, `denials`, `degraded`, `truncated`, `evicted`, `usage`, `metrics`, `configHash`, `capabilities`, `workspaceChanges`, `audit`, `firstFailingStep`, `failure`.
- **Metrics** (`TraceMetrics`, #74): `durationMs`, `terminalStatus`, `toolCalls`, `toolFailures`, `modelCalls`, `tokens { input, cachedInput, output }`, `retries`, `denials` — all equal to direct event counts. (`modelCalls` currently counts `model.completed` events only; #129 adds per-turn spans.)
- **Capabilities** (three states, PRD §8): `observed` when any event of that category exists, `unavailable` only when the runtime declared `capability.unavailable`, otherwise `unknown` — never inferred from absence.
- **Failure focus**: candidates are events with error/timeout/cancelled status or `error.recorded`; ranked by match with the terminal status, then denials, then sequence, then category rank (`tool` first). A restart-cancel points at the deepest incomplete runtime span instead of itself. `formatExitCode` adds hints for 2, 124, 126, 127, 130, 137 and Windows `0xC0000142`; the diagnosis sentence includes cleanup evidence (container exit / termination signal), capability gaps and degradation.
- **Audit projection** (`projectAudit`, #82, #135): one row per control, policy, sandbox, tool and terminal runtime event — `{ at, actor {type,id}, action, resource, outcome (allowed|denied|error|timeout|cancelled), eventId, spanId }`; `summary.audit = { actions, denials, actors[] }`. Rows are never synthesized; every `eventId` exists in `/events`.
- **Runs list row** (`/api/runs`): status, agent, timing, `firstFailingStep`, counts, `capabilities`, `toolCalls`, `toolFailures`, `tokens.output`, `denials`, `actions`, `configHash`/`configSnapshot`, `workspaceChanges`, `degraded`/`truncated`/`evicted`/`redacted`, `lastEventAt`.
- **Web view models**: `needsAttention` = error ∪ timeout ∪ cancelled ∪ degraded ∪ `denials > 0` ∪ `toolFailures > 0` (#131); `recoveredFailures` for ok Runs; `liveRuns`; `capabilityCopy` (pending while running, "no evidence — run cut short" after); `spanStatusLabel` (`interrupted` for incomplete spans of a restart-ended Run); `timelineTicks`, `barGeometry` (open-ended bars for incomplete spans, instant markers for 0 ms).

## 7. Verify: cases, evaluators, eval Runs, comparison

Merged foundations:

- **Evaluator registry** (`eval/evaluators.ts`, #83/#122). Deterministic assertions over a `TraceView`, each returning pass/fail with evidence event ids: `terminal_status` (expected trace status), `expected_tool` (a `tool.call.*` with the given program was observed), `max_tool_calls`, `max_duration_ms`, `post_check` (command exit code from `runtime.postcheck.*`). `files_changed` is specified (PRD FR-17) but only prefilled when `workspace.changed` was observed.
- **Post-check runner** (#80/#114). Executes a verification command inside the sandbox against a Run's workspace and emits `runtime.postcheck.started|completed|failed`; consumed by the `post_check` evaluator.
- **configHash** (#79/#112). Deterministic hash of the behaviour-affecting configuration (instructions, model, runtime, sandbox, limits) stamped on `run.created`, the Runs row and the summary; `configSnapshot` stored on the Run.
- **Workspace changes** (#67/#111) and **sandbox briefing** (#97/#116): the starting state and the Agent's knowledge of it.

Designed and in review (PR stack, section 11):

- **Selectable workspaces** (#64 / PR #106): an Agent can be created on, or switched to, a named shared workspace under the root; switching writes `AGENTS.md` there and resets `codexThreadId`; `run.created.attributes.workspace` names it.
- **Workspace templates** (#68 / PR #123): `Start from…` a bounded template directory (`workspace-templates/`, includes the Repo Doctor demo template with a check command); copied on create with platform files written without clobbering template files.
- **Isolated eval Run** (#105 / PR #127): `AgentService` runs a case in a fresh copy of the template under `AGENT_WORKSPACE_ROOT/.eval/<runId>/`, with a fresh Codex thread, without persisting the thread or workspace onto the Agent; cleanup after completion unless `KEEP_EVAL_WORKSPACES=1`.
- **Regression cases** (#84 / PR #128): `RegressionCase { name, prompt (≤ 50 000), workspaceTemplate, baseline { runId, traceId, configHash }, assertions (1..16) }` persisted in `db.json`; "save this Run as a case" prefills assertions from the trace only (expected tools from observed programs, `max_tool_calls` = distinct tool spans × 2, `max_duration_ms` = ceil(observed × 1.5), `terminal_status: ok` when the Run was ok).
- **EvalRun** (#85 / PR #142): a persisted record that executes cases serially through the isolated Run path against the Agent's current configuration, evaluates each resulting trace, and stores per-case results with evidence ids.
- **Comparison** (#86 / PR #144): a pure function over two EvalRuns' stored results — per-assertion table, `REGRESSION` for PASS→FAIL only, FAIL→PASS and unchanged shown but not classified, links to both traces; no score.
- **UI** (#88, #89 — not started): "Save as Regression Case" in the trace header, a cases list with "Run against this Agent", and the comparison table with a REGRESSION banner.

**Acceptance scenario AC-08** (PRD §16.1): run the Repo Doctor fixture from its template → passing baseline with a stable hash → save as a case with an expected tool and a post-check → change only the candidate Agent's instructions so the verification step is skipped → start an EvalRun (fresh template copy, fresh thread) → the candidate fails at least one assertion → comparison marks PASS→FAIL as `REGRESSION`. #91 reproduces this without network or model judgement inside `npm run check`.

## 8. API reference

All `/api/*` routes except `/api/auth` and `/api/health` require `Authorization: Bearer <APP_AUTH_TOKEN>` when the token is set (the local `.env` leaves it empty, which disables auth). Validation errors are 400 with `details`; unknown ids are 404; busy Agents are 409. Every GlassBox response carries `schemaVersion` and `capturePolicy`.

| Method and path | Purpose | Notes |
|---|---|---|
| `GET /api/health` | liveness | `{ ok, service }` |
| `GET /api/system` | runtime/model/provider facts, `codexAvailable` | used by the web banner |
| `GET /api/auth` | whether a token is required | exempt from auth |
| `GET/POST /api/agents`, `GET/PATCH/DELETE /api/agents/:id` | Agent CRUD | `name ≤ 80`, `description ≤ 500`, `instructions ≤ 10 000`; `workspace`/`template` fields in review |
| `POST /api/agents/:id/start`, `/stop` | lifecycle; `/stop` cancels the active Run | cancellation evidence as in section 5 |
| `GET/POST /api/agents/:id/messages` | conversation; `POST` starts a Run (202) | body `{ content }` |
| `GET /api/agents/:id/runs` | Runs of one Agent | |
| `GET /api/runs?agentId=&status=&limit=` | Runs list rows (section 6) | `status` ∈ trace statuses (`running|ok|error|cancelled|timeout|unset`) |
| `GET /api/runs/:id` | Run record | |
| `GET /api/runs/:runId/trace`, `GET /api/traces/:traceId` | `{ summary, spans, events }` | |
| `GET /api/traces/:traceId/events?category=a,b&status=` | filtered events | comma list validated against the enum |
| `GET /api/traces/:traceId/export` | redacted JSON download | `Content-Disposition: attachment; filename="trace-<traceId>.json"`, `exportedAt` |
| `GET /api/runs/:runId/audit`, `GET /api/traces/:traceId/audit` | audit rows | section 6 |
| `GET /api/workspaces`, `GET /api/workspace-templates` | in review (#106, #123) | |
| `GET/POST /api/regression-cases`, `/:id`, `POST /api/runs/:id/regression-case` (read-only draft prefill; `POST /api/regression-cases` is the only create path), `GET/POST /api/eval-runs`, `GET /api/eval-runs/:id`, `GET /api/eval-runs/:a/compare/:b` | in review (#128, #142, #144) | exact paths may change before merge |

## 9. Configuration, runbook and verification

**Environment variables** (`apps/server/src/config.ts`; the local `.env` is never committed or printed):

| Variable | Default | Meaning |
|---|---|---|
| `HOST`, `PORT` | `0.0.0.0`, `3000` | bind address (`127.0.0.1` in the POC script) |
| `LOG_LEVEL`, `NODE_ENV` | `info`, `development` | pino level; production serves the built web app |
| `APP_AUTH_TOKEN` | unset | bearer token; empty disables auth |
| `APP_DATA_DIR` | `.data` | `db.json` |
| `AGENT_WORKSPACE_ROOT` | `workspaces` | per-Agent and named workspaces; `.eval/` for isolated Runs |
| `CODEX_HOME`, `CODEX_BIN` | `codex-home`, `codex` | Codex state and binary (host runtime) |
| `CODEX_TIMEOUT_MS`, `CODEX_MAX_OUTPUT_BYTES` | `600000`, `2097152` | Run timeout; output cap → `limit.exceeded` |
| `RUNTIME_PROVIDER` | `container` | `local-process` or `container` |
| `CONTAINER_ENGINE`, `CONTAINER_RUNTIME_IMAGE`, `CONTAINER_CPU_LIMIT`, `CONTAINER_MEMORY_LIMIT`, `CONTAINER_PIDS_LIMIT`, `CONTAINER_USER` | `docker`, `volc-agent-runtime:local`, `2`, `2g`, `256`, unset | sandbox limits recorded on `runtime.container.started` |
| `MODEL_PROVIDER`, `ARK_API_KEY`, `ARK_MODEL`, `OPENAI_API_KEY`, `OPENAI_MODEL` | `ark` | model routing; keys reach the runtime only via env |
| `GLASSBOX_CAPTURE_POLICY` | `metadata_only` | or `safe_summary` |
| `GLASSBOX_DEMO_FAILURE` | `off` | `timeout` gates the deterministic 3 s failure fixture |
| `GLASSBOX_TRACE_DIR` | `<APP_DATA_DIR>/traces` | NDJSON files |
| `GLASSBOX_RETENTION_DAYS`, `GLASSBOX_MAX_DISK_MB` | unset | retention (section 4) |
| `KEEP_EVAL_WORKSPACES` | unset | in review (#127) |

**Runbook.**

- Judged path: `npm run poc` (`scripts/start-local-poc.sh`): checks Node ≥ 22 and the container engine, builds `volc-agent-runtime:local`, builds the web app, starts the server on `127.0.0.1:3000` with `LOCAL_POC_DATA_ROOT` as the state root. Stop with Ctrl-C; state persists under `.local/`.
- Windows (Git Bash) invocation used by the controller: `set -a; . ./.env; set +a; unset CODEX_BIN RUNTIME_PROVIDER HOST APP_DATA_DIR AGENT_WORKSPACE_ROOT CODEX_HOME; MSYS_NO_PATHCONV=1 LOCAL_POC_DATA_ROOT="$(pwd -W)/.local" bash scripts/start-local-poc.sh`. Kill the whole process tree (`taskkill /T`) when restarting — killing only the wrapper shell orphans the server and later Docker spawns fail with `0xC0000142`.
- Development: `npm run dev` (server + Vite), `npm run build`, `npm run typecheck`, `npm run test`, `npm run check` (typecheck + tests + guard self-test + build).
- Docker Compose profile and deployment notes: `docs/DEPLOYMENT.md`; local details and troubleshooting: `docs/LOCAL_POC.md`.

**Verification lane** (`npm run test:e2e` → `scripts/e2e/run.sh` + `driver.cjs`, Playwright with the local Chrome; port 3100, its own state root and instance id so it never collides with a live `npm run poc`; `E2E_ENV_FILE` when run outside the main tree). Steps: [1] production server with auth on → 401 without token, 400 for validation in production; [2] baseline: create an Agent, run a real task on the real runner, list/trace/export shapes; [3] export equals the trace body; [4] UI: Runs table → Enter → tree → drawer → focus trap → Escape → filters → Close; [4b] Runs follow the selected Agent, All runs spans Agents, summary strip identities (attention/recovered/running/Live strip); [5] restart with `GLASSBOX_DEMO_FAILURE=timeout` — gated fixture through the real runner, `run.timed_out` names the 3000 ms timeout, no container left behind; [6] Timed-out filter → banner → Jump lands in the drawer on the failing span; audit table rows equal the API; [7] privacy sweep: seeded fakes absent from files, API, export, log, DOM; [8] performance: append p95 < 200 ms, query p95 < 500 ms (vitest guards use 20 ms / 500 ms at 100 events per Run). Last green run on `236bfaf`: 96 checks. Known Windows-only failure in unit tests: one `container-codex-runner` `/tmp` bind-path case. Known lane issue: driver processes can linger after exit (#148).

## 10. Sprint plan and critical path

Sprints are scope units, not days — several can close in one day. One milestone (**TechJam MVP**), labels `sprint:S1…S8`, workstreams `ws:A` starting state & docs · `ws:B` evidence · `ws:C` eval · `ws:D` UI · `ws:E` verification/PRD/demo/submission. Full table with entry/exit gates and status: `docs/SPRINTS.md`; pinned on epic #42.

```text
S0 ▶ S1 ─┬─ S2 (evidence + demo-visible UI) ─────────────────┬─ S6 (verify) ─┬─ S7 (demo) ─ S8 (submission)
         └─ S3 (starting state) ─ S4 (case) ─ S5 (execute+compare) ┘
```

| Sprint | Scope | Exit gate | Status (27 Aug) |
|---|---|---|---|
| S0 | Observe half (#21–#34, #38, #39, #60, #69, #70, #76) | main and E2E lane green | done |
| S1 | Contracts & PRD amendment (#79, #97, #104) | shapes pinned; configHash merged; PRD §16 merged | done |
| S2 | Evidence + demo-visible UI (#81, #82, #74, #72, #87, #98–#102, #90; UAT-3: #129–#138, #143) | denial/audit/metrics real; first-load, live refresh, layout fixed | in progress |
| S3 | Starting state (#64 → #68, #80) | named workspace, template with check command, sandboxed post-check | in review |
| S4 | Regression case (#83, #84, #88) | case saved from a trace with prefilled assertions; UI | in review |
| S5 | Execute & compare (#105 → #85, #86, #89) | ordinary isolated EvalRun; comparison flags PASS→FAIL as REGRESSION | in review |
| S6 | Verify (#91, finish #90) | regression story inside `npm run check`; lane covers new surfaces | not started |
| S7 | Demo (#92; stretch #103) | `run-demo.sh` reaches step 9 from clean state; two rehearsals ≤ 3:00 | not started |
| S8 | Submission (#93, #35, #94, #95) | README verified on a clean clone; video ≤ 3:00 | not started |

**Critical path:** S3 (#64 → #68) → S4 (#84) → S5 (#105 → #85 → #86 → #89) → S7 (#92) → S8 (#94, #95). All S3–S5 items have PRs, stacked #106 → #123 → #127 → #128 → #142 → #144, landing in that order.

**Cut order if time runs out:** #67 (done) → #80 (done) → #89 → #87 (done). Never cut #79, #81, #84, #85, #86, #92.

**Next up (plan after UAT rounds 3–4, 27 Aug):** Track A finish the Verify chain (#142/#144 → #151/#152 → #91/#90 → #92) · Track B evidence quality (#130 → #129 → #132 → #156 → #136) · Track C surfacing fixes (#154, #157, #155, #138, #137; author-blocked #124 #125 #118) · Track D #148 → #90 · Track E submission (#35, #93, #94, #95). #134 deferred past the demo. Full table in `docs/SPRINTS.md` "Next up"; mirrored on #42.

**Demo script (PRD §13, nine steps, ≤ 3 min).** Start a Run from the Repo Doctor template → open its trace → show the first failure / a sandbox denial in the audit tab → save the Run as a Regression Case (assertions prefilled) → change only the Agent's instructions → rerun as an EvalRun from a fresh template copy → comparison flags PASS→FAIL as `REGRESSION` with links to both traces.

## 11. Status board

_Snapshot 27 August 2026, ~16:30 SGT._

- **main** `755546b` — typecheck clean; server 194/195 (the Windows-only `/tmp` case); web 27/27; E2E PASS (117 checks) on `fdaeb57`.
- **Live instance** `localhost:3000` on merged main (container runtime, auth off locally).
- **Merged today (30 PRs):** #78 #120 #112 #116 #113 #109 #117 #119 #115 #108 #111 #114 #122 #107 #121 #126 #139 #140 #141 #145 #147 #150 #106 #123 #127 #128 #159 #161 #163 (+ #77/#76 workflow the night before). S3 and S4 are on main; S5 is in review.

| PR | Issue | Author | Base | Review | Next |
|---|---|---|---|---|---|
| #142 eval runs | #85 | keezhenxian | main | Blocked — 30 s wait ceiling; EvalRuns not closed on restart; no mixed batch test | decision pending (controller fix or author) |
| #144 comparison | #86 | keezhenxian | #142 | Blocked — regressions counted per case, not per assertion | decision pending |
| #151 regression cases UI | #88 | keezhenxian | main | review pending | review with #158 (single create path) |
| #152 comparison UI | #89 | keezhenxian | #151 | review pending | after #151 |
| #125 deep links | #102 | keezhenxian | main | Blocked — rAF race drops `?run=` on reload | author |
| #124 responsive trace | #100 | keezhenxian | main | Blocked — `min-width` causes the scroll it fixes; no screenshots | author |
| #118 a11y round 2 | #103 | PockyFtw | main | Blocked — RunsView key breaks E2E [4b] | author |
| #110 run logs | #75 | PockyFtw | main | Blocked — unredacted runner errors to stdout; deferred scope | hold |

## 12. Issue and PR ledger

**Closed — LaunchGuard era (superseded):** #1 policy profile · #2 capability lease · #3 protected-action gateway · #4 policy evaluator · #5 mock resource · #6 agentctl adapter · #7 RunContext · #8 evidence timeline · #9 human approval · #10 policy panel · #11 redaction canaries · #12 failure semantics · #13 reset script · #14 README/diagram · #15 workshop decisions · #16 recovery hints · #17 budgets · #18 policy diff · #19 decision export · #20 epic.

**Closed — GlassBox Observe (S0):** #21 schema · #22 TraceStore · #23 emitter · #24 Codex stream fixture · #25 trace context · #26 AgentService adapter · #27 query API · #28 runner adapters · #29 redaction pipeline · #30 gated failure fixture · #31 Runs view · #32 trace detail · #33 restart/incomplete/degraded/duplicates · #34 E2E + privacy + performance · #38 export · #39 retention · #41 OTLP adapter · #60 first UAT fixes · #69 · #70 per-Agent Runs + All-runs · #73 timeline axis · #76 workflow guards.

**Closed — S1/S2/S3 items:** #79 configHash · #97 sandbox briefing · #104 PRD v3 · #72 trace visuals · #74 metrics · #81 denials · #82 audit projection · #87 audit view · #98 live refresh · #99 first load · #101 restart trace · #67 workspace changes · #80 post-check runner · #83 evaluators · #131 attention rule · #133 exit hints · #135 actor attribution · #143 E2E case fix · #146 project brief.

**Open — milestone TechJam MVP:** P0 #129 #130 #90 #92 #35 #93 #94 #95 · P1 #64 #68 #84 #88 #105 #85 #86 #89 #91 #100 #102 #132 #134 #136 #138 #149 · P2 #137 #103 #148. **Open — deferred/not in milestone:** #36 workshop decisions · #37 safe_summary usage · #40 SSE · #42 epic · #54 #59 review follow-ups · #65 #66 workspace browser/editing · #75 logs · #96 workspace preview port.

**PR ledger (merged, newest first):** #147 docs brief · #145 E2E case · #141 attention + Live strip · #140 actor attribution · #139 exit hints · #126 audit view · #121 audit projection · #107 OTLP · #122 evaluators · #114 post-check · #111 workspace changes · #108 trace visuals · #115 live refresh · #119 restart trace · #117 first load · #109 metrics · #113 denials · #116 sandbox briefing · #112 configHash · #120 PRD v3 · #78 timeline · #77/#76 workflow guards · #71 · #69 · #61–#63 · #60 · #55–#58 · #43–#53 (Sprint 1 stack).

## 13. UAT history and findings

_The feature-by-feature coverage table, the E2E lane steps and the list of untested areas live in `docs/UAT_COVERAGE.md`._

| Round | Date | Scope | Outcome |
|---|---|---|---|
| 1 | 26 Aug (afternoon) | First run of the Observe half on the POC | Validation errors were 500 in production (error handler registered after static) → fixed in #60; capabilities inferred `unavailable` from absence → third state `unknown` |
| 2 | 26 Aug (evening) | Exploratory Playwright pass against the PRD | Issues #98–#103: live refresh, first-load banner/empty table, layout at 1366/1024/800, restart wording, deep links, keyboard/a11y |
| 3 | 27 Aug (02:45–03:00) | Four live scenarios (happy path, missing `curl`, tool failure + recovery, cancel) plus a restart-cut Run forensic | Report: <https://claude.ai/code/artifact/25d8f2af-092f-45f7-b2a3-aaaf976f5435>. Issues #129–#138 |

**Round 3 findings in detail.**

| Finding | Evidence | Issue |
|---|---|---|
| `ok` means the process exited 0, not that the task succeeded | S2 failed (`curl` absent, exit 127) and read `ok`; S1 needed 9 tool calls with 2 failures and looked clean | #131 (shipped), #132 |
| Model time is a black hole | 83 s + 62 s of S1's 177 s had no event; `modelCalls` always 1 | #129 |
| Tool calls have no duration or identity | instants only; `bash · 61 bytes · exit 0` | #130 |
| Exit codes without hints | 127 twice | #133 (shipped) |
| No per-Agent baseline | 464 k input tokens for one command not flagged | #134 |
| Dashboard hides live Runs; ok traces open collapsed | default filter status-only | #131 (shipped) |
| Audit attributes agent actions to the human | all rows `human/local-user` | #135 (shipped) |
| Restart interruptions understate lifetime | `52 ms` for a Run alive ≥ 61 s | #136 |
| "NO EVIDENCE" conflates two situations | chat-only ok Run vs cancelled Run with tool evidence | #137 |
| Span drawer covers the trace | Jump button and timeline hidden at 1366 px | #138 |

## 14. Working agreements, decisions, risks

**Working agreements.**

- **Plan before code.** Every implementation issue cites a PRD id; the sprint table on #42 is the source of truth for scope and order; issues follow the template (Problem / Why / Scope / Out of scope / Suggested implementation / Acceptance criteria / Dependencies / Demo evidence / Complexity).
- **Claim, then branch.** `bash scripts/dev/claim-issue.sh N` assigns the issue, adds `in-progress` and posts a race-safe claim token (server-clock window); branches are `feat|fix|docs/N-slug`. `.claude/hooks/guard-bash.cjs` refuses branch creation for unclaimed issues, a second session on the same issue, commits/pushes on branches owned by another session (`OCULITH_OWNER_OVERRIDE=1` as a leading env assignment for controller takeovers), `gh pr merge`, pushes to main, force pushes and branch deletion. `release-issue.sh N --review|--abort` when done. `scripts/dev/test-guards.sh` (48 cases) runs inside `npm run check`.
- **Every PR gets an adversarial review** posted as a comment whose first line is `## Review — Mergeable` or `## Review — Blocked` (optionally `Blocked (rebase only; the code itself is mergeable)`), with `### Blocking`, `### Follow-ups (non-blocking)`, `### Verified` (file:line) and `### Merge-order notes`, after a `git merge-tree` against current main.
- **Merges only through** `bash scripts/dev/merge-prs.sh <pr…>`: requires the latest review verdict to be Mergeable, refuses drafts, creates a merge commit, retargets stacked PRs to main before deleting the head branch, clears workflow labels.
- **Controller follow-ups.** When a blocker is bounded and on the critical path, the controller fixes it on the author's branch in a fix worktree, notes it on the PR, and re-posts the verdict with toolchain evidence (typecheck, server and web vitest, vite build; full E2E lane after each batch on main).
- **Secrets.** Never print or commit `.env` (hooks block `cat .env`; the commit hook scans for secrets); API keys never reach argv or traces; `.local/` and `codex-home/` are off limits.
- **Windows quirks.** CRLF-aware conflict resolution; the `/tmp` container-runner unit test; `MSYS_NO_PATHCONV=1` for the POC script; kill process trees, not wrapper shells.

**Locked decisions (PRD Appendix A and later).** MVP centre = single-Run observability + failure diagnosis · storage = NDJSON per Run behind `TraceStore` + rebuildable index · capture = `metadata_only` default, `safe_summary` opt-in, raw prohibited · update model = polling, SSE only after P0 · no Collector/DB/cloud dependency · `SCHEMA_VERSION` stays `1.0` (additive changes only) · Verify has no LLM judge, no score, no replay · sprints are scope units with exit gates, not calendar days · Runs are scoped per Agent with an All-runs overview · workspace configurability limited to choosing/switching the workspace (#64) with browsing/editing deferred (#65, #66, #96).

**Risks and open decisions.**

| Item | Why it matters | Proposed resolution |
|---|---|---|
| Verify chain: #142/#144 still blocked | EvalRun and comparison are the demo's steps 6–7; #151/#152 (UI) stack on them | Decision: fix #142/#144 blockers as controller follow-ups (fastest) or hand back to the author |
| Runtime-layer blindness (#129/#130) | Model time and tool identity invisible; weakens the demo's "why did it fail" beat | Start right after the chain lands; observer-only, no contract break |
| `safe_summary` as the POC default | Without it tool rows have no identity under `metadata_only` | Decide once #130's `argument0` exists |
| UX-03 PRs author-blocked (#124, #125, #118) | The demo runs on a laptop | Three small fixes requested on the PRs; #138 filed separately |
| Demo determinism (#92) | Real Runs take 20–180 s and vary | Repo Doctor template, controlled denial, candidate instruction change, backup video (#95) |
| Restart evidence (#136) | Interrupted Runs understate lifetime | Heartbeat + first-output event |
| E2E driver leak (#148) | Orphaned drivers made server tests flaky | Close browser in `finally`, explicit `process.exit`, trap in `run.sh` |

## 15. Glossary and links

| Term | Meaning |
|---|---|
| Agent | A configured assistant (name, instructions, workspace, Codex thread) |
| Run | One message turn executed by the runtime; owns one trace |
| Trace / span / event | The Run's evidence: a tree of spans reconstructed from ordered events |
| Capture policy | `metadata_only` (counts and ids) or `safe_summary` (bounded redacted text) |
| Capability state | `observed`, `unavailable` (declared), `unknown` (no evidence either way) |
| Failure focus | The first actionable failing span with a diagnosis sentence |
| Audit row | actor / action / resource / outcome derived from one stored event |
| Regression Case | A saved prompt + starting state + deterministic assertions |
| EvalRun | Serial execution of cases through isolated Runs, with stored results |
| Comparison / REGRESSION | Per-assertion diff of two EvalRuns; PASS→FAIL is flagged, nothing is scored |
| Controller | The coordinating session that reviews, lands and unblocks PRs |

Links: repository `Reallyeasy1/Oculith` · epic #42 · milestone "TechJam MVP" · `docs/PRD.md` · `docs/SPRINTS.md` · `docs/ARCHITECTURE.md` · `docs/LOCAL_POC.md` · `docs/DEPLOYMENT.md` · `docs/CODEX_EVENTS.md` · `.claude/rules/glassbox-invariants.md` · `.claude/rules/parallel-work.md` · `scripts/dev/` · `scripts/e2e/` · UAT round 3 report (artifact `25d8f2af-092f-45f7-b2a3-aaaf976f5435`) · project brief page (artifact `28c431ee-2488-40bb-9cf4-9cdbc8c9dc29`). Team on GitHub: Reallyeasy1 (controller), PockyFtw, keezhenxian.
