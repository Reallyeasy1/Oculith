# PRD — Oculith: observability-first middleware for Agent Runs

| | |
|---|---|
| **Track** | TikTok TechJam 2026 · Track 1 "Agent Launchpad: Design and Build Lightweight Agent Middleware" |
| **Repo** | github.com/Reallyeasy1/Oculith (built on the RrankPyramid/CodeJam Starter Kit) |
| **Status** | Draft v4 — 27 Aug 2026 (Observe + Audit + Evaluate + Verify) |
| **Source** | *Oculith Observability PRD* (25 Aug 2026) + Track 1 problem statement §1.1–1.12 |
| **Decision** | **Ship evidence before control.** Single-Run observability and failure diagnosis are the MVP; orchestration is roadmap. |
| **Horizon** | Sprint plan S0–S8 (Observe → Verify) and E1–E3 (Evaluate, in parallel with S6–S8); tracked on the **TechJam MVP** GitHub milestone |

**Change log — v4 (27 Aug 2026, #167).** This version is an amendment, not a rewrite: v3 text stands unless a section below says otherwise. It adds the **Evaluate** plane as new §17 (FR-20…FR-26, AC-09): versioned evaluator definitions, evaluation results with provenance, `executionStatus` vs `taskOutcome`, a per-Run summary store with historical aggregates, background evaluation jobs, the Task Completion evaluator v1, and config comparison over history with a reliability dashboard. It states the three-vocabulary rule once (§17.1 — *observed fact · derived diagnosis · evaluator judgement*), amends §16.2 so deterministic Verify stays LLM-free and remains the only classifier of `REGRESSION`, adds the fixture-vs-telemetry privacy semantics (§17.4, referenced from §8 and §9), amends Appendix A so PostgreSQL is an optional backend behind the existing store interfaces while NDJSON + `db.json` remain the judged one-command path, rewrites the §13 demo script to the historical path with at most one live Run, and extends §16.3 traceability to #167–#177. The organisers' constraints quoted in v3 and `docs/PROBLEM_STATEMENT.md` are unchanged.

---

## 1. Problem statement

A Run on the Starter Kit is a black box. The Playground shows a final message or a one-line error ("Codex timed out after 600000 ms"), but nothing connects the HTTP request, `AgentService` state transitions, the `AgentRunner` process/container, Codex's own event stream, workspace changes, and the terminal result into one navigable context. When something fails, operators cannot tell *which layer* failed, whether it was a timeout, cancellation, model error, tool error, or the platform degrading — so they guess or reproduce blindly.

We hit this ourselves during baseline testing: a 10-minute timeout that looked like a model problem was actually every shell command taking 40 s because of a host PowerShell profile. The evidence existed (Codex's rollout JSONL had every timestamp) but nothing in the product surfaced it. Track 1 explicitly leaves "trace timeline" and "audit model" as intentionally absent middleware, and the naive fix — dump everything to a log — turns observability into a secret-leak liability (prompts, keys, headers, environment).

**Cost of not solving it:** slow debugging, weak demo evidence, and no factual substrate for any future control (retries, budgets, approvals, routing) — a controller built first would be as opaque as the Runs it controls.

## 2. Product concept

**Oculith** is a thin observation plane alongside the existing execution path. It instruments the real seams (Fastify → `AgentService` → `AgentRunner` → runtime/container → Codex → workspace), normalises everything into one versioned `ObservationEvent` contract through a single redaction boundary, persists it locally, and exposes a Runs index and a Trace detail view with first-failure focus.

**MVP outcome**
1. A successful Run can be followed from the HTTP boundary to the runtime result in one trace.
2. A failed Run exposes the failing layer and an actionable error within two interactions / ten seconds.
3. Seeded secrets never appear in persisted or returned trace data.
4. The Starter Kit flow remains usable and starts with one documented command.

**Principles:** evidence over animation · trace events, not chain-of-thought · redact before persistence · stable contract, flexible adapters · graceful partial visibility (observed / derived / unavailable / unknown / redacted / truncated — never invented) · lightweight by default (no Collector, DB, or cloud) · instrument the seams.

## 3. Goals

| # | Goal | How we know |
|---|---|---|
| G1 | Every real Run correlates into one trace with stable `traceId / spanId / runId / agentId / sessionId / requestId / actorId / sequence` | 100 % of demo Runs create a trace with a terminal status; IDs follow §8 |
| G2 | Hierarchy, status, timing, errors, cancellation, retries, runtime/container metadata and usage are visible when available | AC-01: success trace shows ingress → service → runner → runtime → workspace → terminal with stable parentage |
| G3 | Operator finds the first actionable failure fast | AC-02: ≤ 2 interactions and ≤ 10 s from Runs list to the failing span |
| G4 | Secrets never reach any observation surface | AC-03: seeded fake Ark/OpenAI/bearer/private-key fixtures absent from NDJSON files, API, UI text, export, logs, test snapshots |
| G5 | Baseline preserved | AC-07: starter-kit acceptance flow passes; `npm run check` green |
| G6 | Contract can drive future controls without re-instrumenting | Emitters never import UI; `TraceStore` is an interface; a `ControlDecision` slot is reserved in the schema |

**Success metrics:** trace coverage 100 % · diagnostic speed ≤ 2 interactions / ≤ 10 s · 0 secrets visible · every required layer has an observed span *or* an explicit `capability.unavailable` · append p95 < 20 ms at 100 events/Run, 500-event query p95 < 500 ms · telemetry-store failure never crashes a Run; redaction fails closed · one documented start command.

## 4. Non-goals (MVP)

| Non-goal | Why |
|---|---|
| Capturing **raw** chain-of-thought, full prompts/completions, raw headers, raw env | Privacy principle; `full/raw` capture policy is *prohibited*, not merely off. Reasoning text exists only as bounded 240-char redacted summaries under the explicit opt-in `reasoning_summary` policy (#259) — never raw, never by default |
| Replacing Jaeger/Grafana/Datadog/OTel Collector | Six days; local NDJSON + in-memory index is enough; OTLP mapping is P2 |
| Multi-tenancy, enterprise identity, hardened authz, compliance archive | Different track; `actorId = local-user` suffices |
| Scheduler, workflow engine, router, A2A gateway, reconciliation controller | Phase 1–3 roadmap; only work that strengthens *evidence* is accepted |
| Requiring ECS/cloud | Local POC is the judging path |
| Guaranteeing model/tool-level events | Only emitted when the runtime genuinely exposes them; otherwise `capability.unavailable` |

## 5. Users & user stories

**Personas:** Agent developer/operator · Platform maintainer · Hackathon evaluator · Future controller (consumer of facts).

**P0**
- As an **operator**, I can open a Run and see one connected tree/timeline from request receipt to terminal result.
- As an **operator**, I can filter to errors and jump to the first failing span with status, duration, error type and a safe summary.
- As an **operator**, I can distinguish timeout, cancellation, runtime failure, model failure, tool failure and platform degradation.
- As a **maintainer**, I can add an adapter that emits the same `ObservationEvent` schema without changing the UI contract.
- As a **maintainer**, I can prove a sensitive fixture was redacted *before* persistence.
- As an **evaluator**, I can watch one successful Run and one controlled failure while the rest of the platform stays usable.

**P0 edge stories**
- As an **operator**, when the trace store is down I still get my Run's real result and a visible `telemetry.degraded` gap, not a crash.
- As an **operator**, after a server restart the in-flight Run shows as cancelled/incomplete with its open spans marked, not silently closed.
- As a **maintainer**, duplicate `eventId`s (retried appends) never double-count spans, events or usage.

## 6. Requirements

### 6.1 Must-have (P0)

| ID | Requirement | Acceptance |
|---|---|---|
| FR-01 | **Create trace** at the Fastify boundary (`POST /api/agents/:id/messages`); bind `requestId, runId, agentId, sessionId, actorId, schemaVersion, capturePolicy` | Every Run record carries `traceId`; `http.request.received` is the root span with `run.created` as its child (see §7) |
| FR-02 | **Propagate context** through `AgentService.sendMessage/executeRun`, `AgentRunner.run`, both runners, async callbacks, store, query responses | `traceId`/`spanId` present on every event; runner events have the service span as parent |
| FR-03 | **Emit spans/events** at seams: start/end/error/cancel/timeout with monotonic `sequence` + wall clock | Success Run yields ≥ 6 observed spans across categories `control` and `runtime` (`workspace` only when the runtime exposes file changes — not observed on the Codex/Ark stack, see docs/CODEX_EVENTS.md) |
| FR-04 | **Normalise & validate** every event against the zod schema; quarantine malformed fields without corrupting the Run | Malformed adapter event ⇒ `error.recorded` + quarantine, Run continues |
| FR-05 | **Redact before storage**: allowlist operational fields → structured key denylist (`authorization, apiKey, token, secret, password, cookie, privateKey`, case-insensitive) → bounded pattern scan (bearer, `sk-`, `ark-`, AK/SK, private-key blocks, credential URLs, seeded fixtures) → truncation; same serializer for disk, API, export, logs | AC-03; on redactor error persist metadata only with `privacy.reason = redaction_failed_closed` |
| FR-06 | **Persist locally**: append-only NDJSON per Run under `APP_DATA_DIR/traces/<runId>.ndjson`; in-memory summary index rebuilt at start; `TraceStore` interface | Round-trip + rebuild test; atomic append |
| FR-07 | **Roll up state** deterministically: status, duration, event count, first error, usage totals, incomplete spans, degraded signals | Same events ⇒ same rollup (pure function test) |
| FR-08 | **List Runs**: `GET /api/runs?status&agentId&from&to&cursor&limit`, newest first, bounded pagination | 400 on malformed filters |
| FR-09 | **Read trace**: `GET /api/runs/:runId/trace` (+ `/api/traces/:traceId`, `/api/traces/:traceId/events`) returns spans, events, capability + privacy metadata, `schemaVersion`, `capturePolicy` | 404 on unknown id; never raw secrets/provider payloads |
| FR-10 | **Focus failure**: first actionable error + causal path; differentiate failure / timeout / cancellation / observability degradation | AC-02; deterministic diagnosis text built only from stored facts (no LLM) |
| FR-11 | **Controlled failure fixture**: deterministic, gated (`GLASSBOX_DEMO_FAILURE=timeout`; MVP ships `timeout` only — one deterministic failure is enough, `runner_error` dropped), traverses the *same* Run/instrumentation path; disabled by default | AC-02 reproducible twice in a row; fixture off ⇒ baseline unchanged |
| UX-01 | **Runs views**: per-Agent and All-runs views; columns status, Agent, start, duration, first failing step, event count, runtime/model, usage, and trust indicators; quick filters; keyboard-navigable rows; status as text + icon | Newest first; one polling loop keeps the list and an open trace consistent; All-runs aggregates across Agents |
| UX-02 | **Trace detail**: fixed summary header; nested tree/timeline; local filters; span drawer; persistent first-error/denial banner with *Jump to failing span*; capability states exactly `observed | unavailable | unknown`; redaction/truncation/degradation/incomplete evidence; `endedReason=server_restart` is explicit | Operator reaches failing evidence in ≤ 2 interactions; no absent evidence is presented as observed |
| UX-03 | **Reliable demo shell**: truthful disposable-workspace guidance, quiet first load, live refresh, laptop-width layouts, restart wording, deep links and keyboard focus | A cold load never shows a false warning or hides existing Runs; externally started Runs and terminal trace state appear within one polling tick |
| V-01 | **Verification**: unit (IDs, schema, ordering, span reconstruction, rollups, redaction, truncation, duplicates, incomplete), integration (Fastify→Service→Runner→store on success/timeout/error/cancel/restart/degraded store), privacy, E2E, regression, performance | All AC-01..07 automated where possible; `npm run check` green |

### 6.2 Nice-to-have (P1)
- **Usage & safe I/O summaries** (tokens from `turn.completed`, request/result summaries) only under `safe_summary` policy.
- **Export** `GET /api/traces/:traceId/export` — redacted, schema-versioned JSON identical in policy to the query response.
- **Capture policy config**: `metadata_only` (default), `safe_summary` (opt-in local/demo) and `reasoning_summary` (opt-in superset: adds bounded redacted reasoning summaries, #259); `full/raw` not implemented.
- **Bound storage**: caps 1,000 events/Run, 32 KB/event, 10 MB/Run, age cleanup; truncation is observable (`trace.truncated`).
- **Live update**: 1–2 s polling first; SSE only after P0 is complete.

### 6.3 Future (P2 — design for, don't build)
- OTLP / OTel GenAI semantic-convention mapping via a separate adapter (internal schema stays authoritative).
- Operational controls (retry, cancel, approval, budget, alert) written as linked `ControlDecision` records — never mutating observation facts.
- Task graph, routing, reconciliation, multi-agent/A2A spans, delegated identity.

## 7. Architecture & integration

```
Browser ── Runs view / Trace detail (evidence only, no control)
   │  GET /api/runs · /api/runs/:id/trace · /api/traces/:id[/events|/export]
   ▼
Fastify ──onRequest hook: TraceContextFactory (requestId, traceId, actor, policy)──► http.request.* events
   │
AgentService ──adapter──► agent_service.run.* / run.* events   (sendMessage / executeRun / cancel / initialize)
   │
AgentRunner ──adapter──► runtime.container.* / runtime.codex.* / tool.call.* / workspace.changed
   │   (CodexRunner + ContainerCodexRunner share parseCodexEventLine → richest source of runtime facts)
   ▼
ObservationEmitter ──► validate (zod) ──► RedactionPipeline ──► TraceStore (NDJSON/Run + index)
                                                                    │
                                                        TraceQueryService (spans, rollup, first-error focus)
```

| Component | Responsibility | Lives in |
|---|---|---|
| `TraceContextFactory` | IDs, capture policy, schema version, actor at ingress | `apps/server/src/glassbox/context.ts` |
| `ObservationEmitter` | tiny adapter API: timestamp, sequence, validate, forward; **non-blocking, never throws into the Run** | `glassbox/emitter.ts` |
| Fastify hooks | create/attach context, emit request boundaries | `app.ts` |
| `AgentService` adapter | lifecycle + Run state facts; links existing `AgentRun` to `traceId` | `agent-service.ts` |
| `AgentRunner` adapter | container/process/Codex facts, cancellation, timeout, exit, usage, and tool/file events from the Codex JSONL stream | `codex-runner.ts`, `container-codex-runner.ts` |
| `RedactionPipeline` | allowlist → key denylist → pattern scan → truncate; fail closed | `glassbox/redact.ts` |
| `TraceStore` | interface; NDJSON-per-Run impl + rebuildable index | `glassbox/store.ts` |
| `TraceQueryService` | spans from events, rollups, failure focus, filters | `glassbox/query.ts` |
| Trace UI | Runs index + trace detail | `apps/web/src/` (mounted in existing `App.tsx` shell) |

**Integration rules:** preserve public Agent CRUD/lifecycle/Playground/Run behaviour; keep provider keys on the backend; use the existing `AgentService`/`AgentRunner` seams (no parallel demo path); the failure fixture uses the same path and is config-gated; if no model/tool events are exposed, emit `capability.unavailable` once; ECS is infrastructure metadata, never a scoring shortcut.

**Codex event stream (Day-1 confirmation item):** `codex exec --json` already streams JSONL that `parseCodexEventLine` partially consumes (`thread.started`, `item.completed[agent_message]`, `turn.completed.usage`, `error`). The same stream carries `item.started/completed` for `command_execution` (command, exit code, aggregated output), `file_change`, `reasoning` summaries and `turn.failed`. The runner adapter should map these to `tool.call.*`, `workspace.changed`, `model.*` **only after capturing a real stream on Day 1** and confirming field names for the pinned Codex version — never from memory.

## 8. Observability data contract

**Identifiers:** `traceId` (required, one per Run in MVP) · `spanId`/`parentSpanId` (root omits parent) · `runId` (required) · `agentId` (required) / `agentVersionId` (optional) · `sessionId` (= Codex thread id, when available) · `requestId` (required at ingress) · `actorId`/`actorType` (human | service | agent | controller — `human/local-user` for requests and user cancellations, `agent/<agentId>` for the tool/model/workspace actions the agent takes, `service/runner` for runtime lifecycle, `service/sandbox` for denials, `service/server` for restart cancellations) · `attempt` (default 1) · `sequence` (monotonic per trace, required).

**Envelope**
```json
{
  "schemaVersion": "1.0", "eventId": "evt_…", "sequence": 17,
  "traceId": "trc_…", "spanId": "spn_…", "parentSpanId": "spn_…",
  "runId": "…", "agentId": "…", "sessionId": "…",
  "timestamp": "2026-08-25T10:15:22.531Z", "type": "runtime.codex.completed",
  "category": "runtime", "phase": "end", "status": "ok", "durationMs": 18420,
  "source": { "component": "AgentRunner", "adapter": "CodexRunner", "observed": true },
  "attributes": { "attempt": 1, "exitCode": 0 },
  "summary": { "text": "Codex process completed", "policy": "safe_summary" },
  "privacy": { "redacted": false, "rulesetVersion": "1" }
}
```

**Phase:** `start | end | instant` — required on every event; the query layer reconstructs spans by pairing `start`/`end` on one `spanId` (an `instant` event is a point in time, and an unpaired `start` stays *incomplete*).

**Status:** `running | ok | error | cancelled | timeout | unset`. A parent becomes `error` only when an unhandled descendant error reaches the Run; handled failures stay events on an `ok` parent. Incomplete spans are *marked*, never guessed closed.

**Categories:** `experience, control, runtime, model, tool, workspace, sandbox, policy, infrastructure`.

**Minimum taxonomy:** `run.created/started/completed/failed/cancelled/timed_out` · `http.request.received/completed` · `agent_service.run.started/completed/failed` · `runtime.container.started/stopped` · `runtime.codex.started/completed/failed` · `model.request/completed`, `tool.call.started/completed/failed` (when available) · `workspace.changed`, `policy.denied`, `limit.exceeded` · `error.recorded`, `telemetry.degraded`, `trace.truncated`, `capability.unavailable`.

**Redaction is not an event.** There is no `redaction.applied` event: every event records its own redaction outcome inline on its `privacy` block (`redacted`, `rulesetVersion`, `rules`, `reason`, `originalBytes`/`storedBytes`), so evidence and its treatment can never drift apart.

**Capture policy:** `metadata_only` (default: IDs, timing, status, names, counts, codes, sizes, flags) · `safe_summary` (opt-in: bounded, filtered, redacted summaries) · `reasoning_summary` (opt-in: everything `safe_summary` captures plus 240-char redacted reasoning summaries as `model.reasoning` events, #259) · `full/raw` (**not implemented**).

**Fixtures are not telemetry (v4).** The capture policy governs what *instrumentation* persists. `RegressionCase.prompt` and the conversation messages a user submits are **fixtures** — explicit, user-created evaluation data with their own semantics — and the evaluator input view built from them is redacted before any model request and never persisted; see §17.4.

**Evidence states:** `observed` (emitted by instrumented component) · `derived` (computed deterministically from stored facts) · `unavailable` (the Run completed and the component exposed nothing for that layer) · `unknown` (the Run was cancelled, timed out, or its stream never started — including error Runs that died before the first stream event — so that layer said nothing; absence proves nothing and no `capability.unavailable` is emitted) · `redacted` · `truncated`. Per-layer capabilities (`model`, `tool`) take exactly `observed | unavailable | unknown`; the UI renders `unknown` on an ended Run as `model: no evidence` / `tool: no evidence` (long form in the tooltip); an ok Run with zero tool calls is a neutral `no tool calls`, not missing evidence (#137). Evaluator judgements (§17.1) are **not** evidence states of this contract: they are stored as results with provenance and are never emitted as events.

## 9. Failure & degraded behaviour

| Condition | Required behaviour |
|---|---|
| Runtime timeout (`CODEX_TIMEOUT_MS`) | runtime span `timeout`, Run `timeout`, retain exit/cleanup evidence, focus first timeout |
| Model/provider error | mark at highest available granularity; never fabricate provider detail |
| Tool failure | tool span `error` when exposed; parent status follows the real runtime result |
| Cancellation (`stop`) | record actor, request time, ack, runner termination, terminal `cancelled` |
| Process restart | reuse `AgentService.initialize` semantics: Run → cancelled/incomplete, rebuild index, mark open spans incomplete |
| Trace store unavailable | Run continues; best-effort `telemetry.degraded` in memory/log-safe channel; UI shows evidence gap |
| Redaction failure | drop payload, keep safe metadata + `redaction_failed_closed`; Run continues |
| Event cap reached | drop content-bearing events first, keep terminal + error metadata, record `trace.truncated` |
| Evaluation job or model-provider failure (v4) | Run unaffected — evaluation never sits in the Run path (FR-24); the failing Run increments `failedRuns` with a stored error and the job continues; restart ⇒ job `interrupted`, resumable; result `explanation` redaction fails closed exactly like FR-05 (§17.4) |

## 10. Verification plan

| Layer | Coverage |
|---|---|
| Unit | ID generation/propagation, schema validation, ordering, span reconstruction, rollups, redaction rules, truncation, duplicate `eventId`, incomplete spans |
| Integration | Fastify → AgentService → AgentRunner → store on success, timeout, runtime error, cancel, restart, store degradation (real service on `mkdtemp` + `FakeRunner`) |
| Privacy | seed fake Ark/OpenAI/bearer/private-key fixtures; assert absence across NDJSON, API, export, logs, snapshots, rendered UI text |
| E2E | create Agent → run task → open trace → expand span → filter errors; controlled failure → jump to failing span |
| Regression | CRUD, lifecycle, Playground, session/workspace persistence, `npm run check` |
| Performance | append/query benchmarks at 100/500 events; caps; no unbounded UI render |

**Acceptance scenarios:** AC-01 Success · AC-02 Failure · AC-03 Privacy · AC-04 Partial visibility (`capability.unavailable`, no synthetic model/tool events) · AC-05 Degraded store · AC-06 Restart · AC-07 Baseline.

**Definition of done:** all P0 FRs + AC-01..07 pass locally; demo runs twice consecutively from a documented setup with no manual edits; one-page architecture diagram + README explain seams, schema, redaction, limitations, extension points; no seeded secret in recording, screenshots, fixtures, traces, logs; limitations (single process, local store, partial provider visibility, bounded capture) are explicit.

## 11. Open questions

**Blocking (resolve Day 1)**
- *Engineering:* exact Codex CLI `--json` event/field names for the pinned version (0.111.0 in Docker, 0.142.x on the Windows host) — capture a raw stream from a real Run and check it in as a fixture before designing `tool.*`/`model.*` mapping.
- *Engineering:* which controlled failure fixture — deterministic timeout (small `CODEX_TIMEOUT_MS` under a gate), gated runner exception, or invalid tool action? Prefer the one that exercises the most real cleanup code without brittleness.

**Non-blocking**
- *Engineering:* immutable `agentVersionId` on Agent edits in MVP or P1? (Cheap: increment on `updateAgent`.)
- *Engineering:* retention defaults — pick age/disk caps after measuring demo trace volume.
- *Team:* `sessionId` = Codex thread id is only known after turn 1 — attach on `thread.started`, backfill on the root span.

## 12. Sprint plan

The authoritative S0–S8 schedule, issue membership, gates, lanes and critical path live on the **TechJam MVP** GitHub milestone and epic #42. S0 is the completed observation plane. S1 pins the Verify contracts before S2–S5 build evidence, starting state, cases, execution and comparison; S6 verifies the complete loop; S7 rehearses; S8 packages the submission. **v4:** the Evaluate plane is sprints E1–E3 (#167–#177, #190–#193), running in parallel with S6–S8; E1 lands the summary/evaluator stores, E2 the jobs, judge and aggregates, E3 the dashboard and comparison that §13 walks through.

**Team split (by contract, not layer):** runtime/starting state (A) · trace/audit (B) · evaluation (C) · experience (D) · verification/submission (E).

**Cut order if slipping:** #67 → #80 → #89 → #87. **Never cut:** #79 config identity, #81 denial evidence, #84 Regression Cases, #85 EvalRun, #86 comparison, or #92 deterministic demo proof. Existing privacy, real instrumentation, baseline regression and trace-detail guarantees remain non-negotiable.

## 13. Demo script (3 min)

*v4: the historical path. Everything except step 6 runs on stored Runs and stored evaluation results (fake-judge results in rehearsal, real `task_completion@1` results in the recording); at most one live Run is started. The deterministic save → rerun → `REGRESSION` loop (AC-08) is shown as the linked EvalRun comparison in step 7, not re-executed live.*

| Time | Step | Beat | Proof |
|---|---:|---|---|
| 0:00–0:15 | 1 | Select the Agent | Open the Demo Agent; the reliability dashboard renders execution completion (labelled *telemetry*) beside task completion "n of m evaluated · task_completion@1" (labelled *evaluation*) with a p95 latency series; no false warnings on a cold load |
| 0:15–0:35 | 2 | Find the problem | Filter the Runs table to `taskOutcome: failed`; one Run reads `executionStatus: completed` **and** `taskOutcome: failed` with its `taskOutcomeSource` — "ok ≠ success" made visible from history, not a fresh Run |
| 0:35–1:00 | 3 | Trace and evidence | Open that Run: the Evaluation panel shows `task_completion@1`, score, `passed: false`, explanation; click the cited event id and the `exit code 127` tool span focuses; the derived diagnosis and the evaluator judgement are labelled apart (§17.1) |
| 1:00–1:15 | 4 | Privacy boundary | The result holds explanation + evidence ids only — no prompt or response text in the API response, the panel or `db.json`; the same redactor sat before the model request (§17.4) |
| 1:15–1:40 | 5 | Batch-evaluate history | Start an evaluation job over the Agent's history; per-Run progress persists; one Run fails to evaluate and the job continues; restart → `interrupted` → resume (rehearsed; skip on the clock if short) |
| 1:40–2:05 | 6 | One live Run | Submit the Repo Doctor task once — the only live Run; it completes in normal time while the job runs and lists as `taskOutcome: unknown` until evaluated. If it is still running at 2:05, continue on stored Runs |
| 2:05–2:35 | 7 | Compare two configs | Open the comparison page: baseline configHash vs the changed-instructions configHash, `configSnapshot` diff, task-completion delta and telemetry deltas with provenance; the page says *quality drift* and links the deterministic EvalRun comparison whose `REGRESSION` (FR-19) is the only classification |
| 2:35–2:50 | 8 | Drill back | Click the task-completion delta cell; the Runs table opens pre-filtered by that cell's provenance; open one Run's trace; return to the dashboard |
| 2:50–3:00 | 9 | Close | Observe → Audit → Evaluate → Verify: facts, diagnoses and judgements kept distinct; every dashboard number traceable to Runs → evaluator version → evidence; one-command local path |

## 14. Roadmap (why the MVP is not throwaway)

`TraceStore` → event backbone (add DB/stream adapter, emitters unchanged) · rollups → state projection for a controller · failure focus → typed retryability → `RetryDecision` · observed usage → budgets · actor context → approvals/revocation/audit · single Run → task graph (`taskId`, dependency edges, attempts) · single agent → A2A (context propagation across agents). A future controller **never mutates observation facts**; it writes a linked `ControlDecision` (`decisionId, traceId, runId, controller version, evidence refs, policy version, action, alternatives, outcome`) and its action produces new *observed* spans.

## 15. Rubric alignment

| Dimension | Weight | Oculith proof |
|---|---|---|
| End-to-end behaviour | 40 % | real task traverses UI → Fastify → AgentService → AgentRunner → runtime/workspace and returns a connected trace; real controlled failure diagnosed |
| Design & integration | 25 % | documented seams, baseline preserved, provider-neutral versioned contract, evidence separated from future control |
| Verification & robustness | 20 % | success/failure/privacy/restart/degradation tests, caps, idempotency, reproducible setup |
| Demo & reproducibility | 15 % | success → trace → failure → diagnosis → privacy proof, one-command local path |

**Narrative:** *Agents fail in ways logs cannot explain. Oculith makes every Run auditable and diagnosable today, and turns that evidence into the control substrate for tomorrow's agent plane.*

## 16. Verify: Audit → Regression Case → EvalRun → Comparison

The Verify loop consumes the observation contract; it never creates a second source of runtime truth. A saved case records a bounded task and starting-state reference, a candidate rerun travels through the real AgentService/AgentRunner seams, deterministic evaluators cite observed evidence, and comparison classifies assertion transitions.

| ID | Requirement | Acceptance |
|---|---|---|
| FR-12 | **Configuration identity:** compute a deterministic `configHash` from behaviour-affecting Agent/runtime configuration and stamp every `run.created`, Run list row and trace summary | Same effective configuration gives the same hash; a relevant change gives a different hash; secrets and machine-specific paths are excluded (#79) |
| FR-13 | **Denial evidence:** emit one `policy.denied` alongside a sandbox-declined tool outcome, with service/sandbox actor and bounded metadata; count and focus denials | Audit and trace identify the declined program; no raw command/output under `metadata_only` (#81) |
| FR-14 | **Audit projection:** derive actor/action/resource/outcome rows from stored control, policy, sandbox, tool and terminal runtime events; every row links to its source event and trace | `GET /api/runs/:id/audit` and trace audit routes return no fabricated rows; summary exposes counts only (#82, #87) |
| FR-15 | **Per-Run metrics:** derive bounded duration, tool/model/error/denial counts and token usage from the same events used by the trace summary | Metrics are deterministic, visible in list/detail, and equal direct event counts (#74) |
| FR-16 | **Regression Case and starting state:** save a Run as a case with bounded prompt, baseline Run/config, workspace-template reference and deterministic assertions; named/template workspaces reproduce the same starting state | Save-from-Run pre-fills evidence-backed assertions; reruns never mutate the baseline workspace (#64, #68, #84, #88) |
| FR-17 | **Deterministic evaluators:** support `terminal_status`, `expected_tool`, `max_tool_calls`, `max_duration_ms`, `post_check`, and `files_changed` only when cheaply observed | Each result is pass/fail with evidence references; `post_check` runs in the sandbox on the judged path (Docker) and falls back to a bounded local process where the sandbox is unavailable (#80); CI uses the fallback (#91) (#80, #83) |
| FR-18 | **EvalRun through AgentService:** execute cases serially as ordinary Runs against current candidate configuration in a fresh template workspace and fresh Codex thread | Agent workspace/thread remain untouched; trace carries case/eval identifiers and FR-12 hash; busy and cleanup semantics remain intact (#105, #85) |
| FR-19 | **Baseline/candidate comparison:** compare per-assertion outcomes and flag PASS→FAIL as `REGRESSION` (FAIL→PASS and unchanged outcomes are shown but not classified — no scoring); link both Runs/traces | Comparison table and summary agree; no score is generated by an LLM (#86, #89) |

### 16.1 Acceptance scenario AC-08 — save → rerun → REGRESSION

1. Run the Repo Doctor fixture from its named template and observe a passing baseline with a stable FR-12 hash.
2. Save the baseline as a Regression Case and rebuild its assertions around the deterministic fresh-workspace post-check.
3. Change only the candidate Agent instructions so the verification step is skipped.
4. Start an EvalRun. It provisions a fresh copy of the same template and a fresh thread, then executes through AgentService.
5. The candidate fails at least one deterministic assertion (the fixture regresses the fresh-workspace `post_check`); comparison marks PASS→FAIL as `REGRESSION` and links the baseline/candidate evidence.
6. The integration fixture reproduces the sequence without network/model judgement and the complete path remains covered by `npm run check` (#90, #91, #92).

### 16.2 Verify non-goals

- **Deterministic Verify stays LLM-free (amended in v4; the v3 line "No LLM judge or probabilistic score" remains true of Verify).** No LLM judge or probabilistic score in an assertion, an EvalRun result or the baseline/candidate comparison. Verify is the **only** place that classifies `REGRESSION` (PASS→FAIL on a deterministic assertion, FR-19). Semantic evaluation lives in §17: it answers "did quality improve or degrade?" over history, may be shown beside a Verify comparison as *quality drift*, and never classifies, upgrades or downgrades a regression.
- No trace replay: a rerun is new execution from a versioned starting state.
- No cross-model tournament or model router.
- No policy engine, approval workflow or control-plane mutation of observation facts.

### 16.3 TechJam MVP traceability

| Requirement | Milestone issues |
|---|---|
| FR-01…FR-11, UX-01/02, V-01 | #21–#35, #38, #39, #60, #69, #70, #72, #76, #93 |
| FR-12 | #79 |
| FR-13 | #81 |
| FR-14 | #82, #87, #135 |
| FR-15 | #74, #129, #130, #134 |
| FR-16 | #64, #68, #84, #88 |
| FR-17 | #67, #80, #83 |
| FR-18 | #85, #105 |
| FR-19 | #86, #89 |
| UX-03 | #97, #98, #99, #100, #101, #102, #103, #131, #132, #136, #137, #138 |
| V-01, AC-08 | #90, #91, #92, #94, #95, #104, #143 |
| Evidence quality (UAT round 3, 27 Aug 2026) | #129 model-turn spans, #130 tool-call spans and identity, #131 attention rule, #132 outcome line, #133 exit-code hints, #134 per-Agent baselines, #135 actor attribution, #136 restart honesty, #137 chip semantics, #138 drawer layout |
| §17 PRD v4 amendment, §17.4 privacy, Appendix A | #167 |
| FR-20, FR-21 | #169, #192 (user-defined evaluators, P1), #193 (safety evaluator, P2) |
| FR-22, FR-23 | #168 (summary store, `taskOutcome`), #190 (metric query + `MetricStore`, P0), #172 (aggregates and compare API) |
| FR-24 | #170 |
| FR-25 | #171; #177 Recovery Quality (P2, later evaluator) |
| FR-26 | #173 (dashboard, drill-back), #174 (config comparison); #134 per-Agent baseline becomes the outlier chip on the dashboard panel |
| FR-16 / FR-18 starting-state integrity (`templateHash`) | #176 |
| Appendix A optional PostgreSQL backend | #191 (P1, phase C — summaries, then results; PR #197), #175 (P2, remaining phases) |
| AC-09 | #170, #171, #172, #173, #174; lane step in #173 |

## 17. Evaluate: versioned evaluators, provenance, history (v4)

Observe answers *what happened*; Verify answers *did a configuration change break a contract?*; **Evaluate** answers *was the Agent actually good, over history, and can every number be traced to its evidence?* Like Verify, Evaluate consumes the observation contract and never creates a second source of runtime truth: it writes no observation events, runs nothing in the Run path, and every judgement it stores names the evaluator version, the model and the event ids it rests on.

### 17.1 Three vocabularies (stated once, referenced everywhere)

| Vocabulary | Produced by | Examples | Mutability |
|---|---|---|---|
| **observed fact** | instrumented components emitting `ObservationEvent` (§8) | `tool.call.failed` with `exitCode 127`, `run.completed`, `policy.denied` | append-only; never edited, never synthesised |
| **derived diagnosis** | `buildTrace` / `TraceQueryService` — pure functions over stored facts | trace status, first actionable failure, per-Run metrics, `executionStatus` | recomputed deterministically; same events ⇒ same diagnosis |
| **evaluator judgement** | an `EvaluatorDefinition` at a fixed version applied to one Run (FR-20/21) | `task_completion@1 → score 2, passed: false`, `taskOutcome` | versioned; a new evaluator version yields a new result, older results are kept |

Rule: every UI label and API field says which vocabulary it belongs to; a judgement is never rendered as a fact; a diagnosis never imports a judgement (`buildTrace` stays pure and LLM-free, invariant 3); a judgement always cites the facts it rests on. Telemetry metrics (derived) and evaluation metrics (judged) are labelled distinctly wherever they appear together (FR-23, FR-26).

### 17.2 Requirements

| ID | Requirement | Acceptance |
|---|---|---|
| FR-20 | **Versioned evaluator definitions:** `EvaluatorDefinition { id, name, version, type: deterministic \| llm_judge, rubric, model?, minScore, maxScore, passThreshold, config, setsTaskOutcome, createdAt }` is immutable once created; any change to rubric, model, scoring or threshold creates a new version. Both planes list in one registry (`GET /api/evaluators`): §16's deterministic kinds as `deterministic` entries, the judge as `llm_judge`, so results share one table | Two versions of one evaluator coexist; every result references the version it was produced with; no in-place edit path exists (#169) |
| FR-21 | **Evaluation results with provenance:** `EvaluationResult { runId, evaluatorId, evaluatorVersion, score?, passed, explanation, evidenceEventIds[], evaluatorModel?, metadata, evaluatedAt, jobId? }` — `passed` is the canonical verdict; `score` is present only for scored evaluators (absent for §16 deterministic pass/fail results, which are written through an adapter mapping each assertion's `pass` to `passed`, and for FR-25's no-final-response result) and score aggregates skip results without one; `evaluatorModel` is set only for `llm_judge`, append-only behind `EvaluationStore`; the current value is the latest per (run, evaluator, version), older ones kept. `explanation` passes the FR-05 redactor before persistence; the evaluator input view (§17.4) is never persisted. `GET /api/runs/:id/evaluations` | A result whose explanation contains a seeded fake secret is stored redacted (privacy sweep extended); every cited event id exists in the trace or the result carries `metadata.uncited = true` (#169, #171) |
| FR-22 | **`executionStatus` vs `taskOutcome`:** `executionStatus` (`running \| completed \| failed \| timeout \| cancelled`) is the *process* outcome, a derived diagnosis: the §8 trace status mapped once, in `glassbox/summary.ts`, as `ok → completed`, `error → failed`, `unset → running`, `timeout`/`cancelled` unchanged; `/api/runs`, the trace summary and filters all read this one mapping. `taskOutcome` (`passed \| failed \| unknown`) states whether the requested task was accomplished; it is a field of the Run summary (FR-23), always paired with `taskOutcomeSource` (`evaluator:<id>@<version> \| deterministic:<evalRunId>`; absent while `taskOutcome` is `unknown`; stored on the summary by #168, surfaced on `/api/runs` rows and the trace summary from #169 onward); it is `unknown` until an evaluator flagged `setsTaskOutcome` or an EvalRun sets it, is updated only by a result write, and is **never an observation event** — the trace is byte-identical before and after evaluation (#168) | `/api/runs` shows `executionStatus: completed, taskOutcome: unknown` for an unevaluated Run and `taskOutcome: failed` with its source after evaluation; NDJSON files unchanged by evaluation |
| FR-23 | **Per-Run summary store and historical aggregates:** `RunSummary` (`rollupVersion`; equals `buildTrace(events).summary` plus outcome fields, so the two never disagree) persisted behind `RunSummaryStore` when the terminal event is appended (non-blocking, like telemetry; recomputed when stale) with a backfill command; `GET /api/runs` reads summaries. Aggregation follows **data → query → aggregation → visualization**: one bounded metric query contract, `POST /api/metrics/query { metric, filter { agentId?, configHash?, from?, to?, executionStatus?, taskOutcome? }, range { lastRuns?: n \| from/to }, aggregation: rate \| avg \| p50 \| p95 \| count \| series(bucket=hour\|day) }` → `{ value, provenance }`, over a **fixed metric catalogue** (no expressions, no free-form query language): telemetry `execution_completion`, `tool_failure_rate`, `tool_calls`, `tokens`, `latency`, `denials` from summaries; evaluation `task_completion` (parameterised by evaluator id + version) from results. The dashboard endpoints `GET /api/agents/:id/reliability?from&to&configHash&bucket=hour\|day` and `GET /api/reliability/compare?agentId&a=<configHash>&b=<configHash>&from&to` are sugar over the same query function. **Telemetry metrics** (execution completion, tool failure rate, tool calls, tokens, latency p50/p95, denials — from summaries) and **evaluation metrics** (task completion by evaluator id + version — from results) are labelled distinctly and never folded into one number; **every number carries `provenance { runIds or count + filter, evaluatorId?, version? }`**; task-completion rate excludes unevaluated Runs and states how many were evaluated. Computed by a `MetricStore` read facade over the two stores (`RunSummaryStore` = objective metrics from the rollup, `EvaluationStore` = semantic metrics from the batch evaluator; each store has a JSON and an optional PostgreSQL backend, Appendix A/#191, #175); **no `metric_samples` table or materialisation unless a measured query exceeds 500 ms on 1,000 Runs** (a test asserts the bound; #168, #172) | Listing 200 Runs performs zero NDJSON reads; rates equal hand computation on a 30-summary fixture across two configHashes; `compare` returns both sides plus deltas; p95 definition documented |
| FR-24 | **Evaluation jobs:** `EvaluationJob { id, evaluatorId, evaluatorVersion, filter { agentId?, configHash?, from?, to?, executionStatus? }, status: queued \| running \| completed \| failed \| interrupted, totalRuns, completedRuns, failedRuns, createdAt, startedAt, completedAt, lastError? }` persisted; a **single in-process worker** started with the server (concurrency 1 across jobs; one model call per eligible Run with at most one retry, ≤ 2 calls per Run) selects Runs with no result for (evaluator, version) unless `force`; each Run is evaluated independently — a failing Run increments `failedRuns` with a stored error and the job continues; a restart marks `running` jobs `interrupted` (as §9 does for Runs) and `POST /api/evaluation-jobs/:id/resume` re-queues the remainder, skipping stored results; provider rate limiting/backoff; **never in the Run path, never mutates trace evidence**. `POST /api/evaluation-jobs`, `GET /api/evaluation-jobs[/:id]` (#170) | Batch of 5 with one throwing ⇒ 4 results, 1 failure, job `completed`; restart mid-job ⇒ `interrupted` ⇒ resume finishes the rest; a Run started during a job completes in normal time (timing assertion) |
| FR-25 | **Task Completion evaluator v1:** `task_completion@1` (`llm_judge`, model = the configured provider model at temperature 0, score 1–5, **pass ≥ 4**, `setsTaskOutcome`). Input is the **trace-grounded, redacted evaluation view** (§17.4): fixtures (user request, final assistant message) plus trace metadata under the Run's capture policy — tool activity (program, exit codes, counts; command heads only under `safe_summary`), tool failures, workspace changes, post-check results, runtime failures/denials, recovery sequence, duration/tokens — each section carrying the event ids it came from; redacted and size-capped before any model request. Output `{ score, passed, explanation, citedEventIds[] }` validated with zod; **explanations cite evidence ids**. Runs with no final message (cancelled/timeout) evaluate `failed` with "no final response", no `score` and no model call. A **deterministic fake judge** serves tests and the E2E lane; the demo uses stored results. **Recovery Quality** (`recovery_quality@1`, not `setsTaskOutcome`, eligible only for Runs with ≥ 1 failure/denial) is a later evaluator over the same view (#177, P2) (#171) | UAT round 3 `curl` Run (`completed`, task failed) ⇒ `passed: false` citing the `exit code 127` tool event; UAT4 template Run ⇒ `passed: true` citing `workspace.changed` and the passing check command; no prompt/response text persisted in results or traces |
| FR-26 | **Config comparison over history and the reliability dashboard:** *Dashboard* (#173) — Agent overview panel above the Runs table (execution completion, task completion "n of m evaluated · task_completion@1", tool failure rate, p95 latency, avg tokens, denials; one small bucketed series each; time-range and configHash filters; #134's per-Agent baseline becomes the outlier chip here); Runs table gets a `taskOutcome` chip and filter; the trace view gets an *Evaluation* panel whose cited event ids focus the span (reusing the audit jump); **every dashboard number drills back** to the Runs behind it via its provenance. *Comparison* (#174) — two configHashes of one Agent with the `configSnapshot` diff, telemetry and evaluation metrics with deltas from `/api/reliability/compare`, each cell drilling to its Runs; labelled **"quality drift"**; **never classifies `REGRESSION`** — that word belongs to the deterministic EvalRun comparison (FR-19), which is linked when one exists for the same pair; no score beyond raw deltas and the evaluator's own pass rate | Demo steps 1–5 and 7–8 work from the browser with stored results; the baseline and the changed-instructions candidate show a task-completion delta with drill-down to the individual traces; lane step covers the panel and drill-back |

### 17.3 Acceptance scenario AC-09 — dashboard → completed-but-failed Run → evidence → batch evaluate → compare two configs → drill back

1. Select the Demo Agent. The reliability panel renders from `/api/agents/:id/reliability`, telemetry and evaluation metrics labelled separately, task completion reading "n of m evaluated · task_completion@1". *Check:* every number equals hand computation over the fixture summaries and results, and its provenance names the Runs (or count + filter) and the evaluator version.
2. Filter the Runs table to `taskOutcome: failed` and pick a Run whose `executionStatus` is `completed`. *Check:* the row shows both fields and a `taskOutcomeSource` of `evaluator:task_completion@1`; the row of an unevaluated Run reads `unknown`.
3. Open its trace. The Evaluation panel lists `task_completion@1`, score, `passed: false` and the explanation; clicking a cited event id focuses the `exit code 127` tool span. *Check:* every cited id exists in the trace; the diagnosis banner (derived) and the panel (judged) carry their vocabulary labels; no prompt/response text appears in the panel or in `GET /api/runs/:id/evaluations`.
4. Start an evaluation job over the Agent's history (fake judge in the lane). *Check:* progress persists per Run; one Run fails to evaluate, `failedRuns` increments and the job completes; restarting the server mid-job leaves it `interrupted` and `resume` finishes without re-evaluating stored results; a live Run started during the job completes in normal time; NDJSON traces are byte-identical before and after.
5. Open the comparison page for the baseline configHash and the changed-instructions configHash. *Check:* task-completion delta and telemetry deltas render with provenance; the page says "quality drift" and never `REGRESSION`; when an EvalRun comparison exists for the pair, it is linked and remains the only place a `REGRESSION` is shown.
6. Click a delta cell. *Check:* the Runs table opens pre-filtered exactly by that cell's provenance; opening a Run and returning keeps the filter.
7. Privacy. *Check:* the sweep finds no seeded secret in `evaluatorDefinitions`, `evaluationResults`, `evaluationJobs`, API responses or rendered panels, and the evaluation view is absent from every store and log.

### 17.4 Privacy: telemetry, fixtures and the evaluator input view

- **Telemetry** is capture-policy governed (`metadata_only` default, `safe_summary` opt-in, `full/raw` prohibited) and redacted at persistence (FR-05, invariants 1–2 and 5). Nothing in §17 widens what instrumentation captures.
- **Fixtures** — `RegressionCase.prompt` and the conversation messages a user submits to an Agent — are explicit, user-created evaluation data with their own semantics: the user wrote them to be run and judged, and the conversation store already holds them under the Starter Kit's existing rules. They are not telemetry and the capture policy does not govern them; they are never copied into traces or results.
- **The evaluator input view** is assembled per Run from fixtures + trace metadata under the Run's capture policy, passes through the same redactor (`redactText`, fail closed) before any model request, is size-capped, and is **never persisted** — not in a result, a job record, a trace or a log.
- **Results** store `explanation` (redacted before write) and `evidenceEventIds` only, plus provenance (evaluator id + version, model, evaluated-at, job id). The privacy sweep (AC-03) extends to every Evaluate store, endpoint and panel.

§8 and §9 reference this subsection; any change here needs a privacy test in the same commit (invariants rule).

### 17.5 Evaluate non-goals

- No LLM in the diagnosis path or in `REGRESSION` classification (§16.2, invariant 3).
- No generic metric definitions, PromQL-like syntax, Grafana compatibility or alerting.
- No distributed scheduler (Kafka, Temporal, Redis, Kubernetes), multi-node workers or cron.
- No statistical significance, more than two sides, or cross-Agent comparison.
- No live judging in the demo; the recording uses stored results.

## Appendix A — Locked decisions
MVP centre = single-Run observability + failure diagnosis · storage = NDJSON per Run behind `TraceStore` + rebuildable index; Run summaries, evaluator definitions, results and jobs in `db.json` behind `RunSummaryStore` / `EvaluationStore` (v4) · capture = `metadata_only` default, `safe_summary` opt-in, raw prohibited · update model = polling, SSE only after P0 · no Collector/DB/cloud dependency on the judged path.

**v4 amendment (#167, #191, #175):** NDJSON + `db.json` remain the judged one-command path (`npm run poc`; the organisers' "smallest useful infrastructure"). **PostgreSQL is an optional backend, not a replacement:** `PostgresTraceStore` / `PostgresRunSummaryStore` / `PostgresEvaluationStore` behind the *existing* store interfaces, selected by `GLASSBOX_STORE=json|postgres` (default `json`) and started by `docker compose --profile postgres`; redaction still happens before `append`, `readRun` returns the same ordered array so `buildTrace()` is untouched, and one conformance suite runs against both backends. #191 is P1 (phase C: summaries, then evaluation results — PR #197); #175's trace/agents phases are P2, promoted only if in-memory aggregation from `db.json` summaries measurably exceeds the FR-23 bound.

## Appendix B — Sources
- TechJam 2026 Track 1 problem statement, transcribed with a requirement-to-PRD mapping: `docs/PROBLEM_STATEMENT.md`.
TechJam 2026 Track 1 brief · Starter Kit `docs/ARCHITECTURE.md`, `docs/HACKATHON_EXTENSION_GUIDE.md` · OpenTelemetry traces, context propagation, GenAI semantic conventions (mapped later; internal schema stays authoritative).
