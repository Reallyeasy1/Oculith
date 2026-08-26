# PRD — GlassBox: observability-first middleware for Agent Runs

| | |
|---|---|
| **Track** | TikTok TechJam 2026 · Track 1 "Agent Launchpad: Design and Build Lightweight Agent Middleware" |
| **Repo** | github.com/Reallyeasy1/Oculith (built on the RrankPyramid/CodeJam Starter Kit) |
| **Status** | Draft v2 — 26 Aug 2026 (supersedes the LaunchGuard PRD v1) |
| **Source** | *GlassBox Observability PRD* (25 Aug 2026) + Track 1 problem statement §1.1–1.12 |
| **Decision** | **Ship evidence before control.** Single-Run observability and failure diagnosis are the MVP; orchestration is roadmap. |
| **Horizon** | Six-day build |

---

## 1. Problem statement

A Run on the Starter Kit is a black box. The Playground shows a final message or a one-line error ("Codex timed out after 600000 ms"), but nothing connects the HTTP request, `AgentService` state transitions, the `AgentRunner` process/container, Codex's own event stream, workspace changes, and the terminal result into one navigable context. When something fails, operators cannot tell *which layer* failed, whether it was a timeout, cancellation, model error, tool error, or the platform degrading — so they guess or reproduce blindly.

We hit this ourselves during baseline testing: a 10-minute timeout that looked like a model problem was actually every shell command taking 40 s because of a host PowerShell profile. The evidence existed (Codex's rollout JSONL had every timestamp) but nothing in the product surfaced it. Track 1 explicitly leaves "trace timeline" and "audit model" as intentionally absent middleware, and the naive fix — dump everything to a log — turns observability into a secret-leak liability (prompts, keys, headers, environment).

**Cost of not solving it:** slow debugging, weak demo evidence, and no factual substrate for any future control (retries, budgets, approvals, routing) — a controller built first would be as opaque as the Runs it controls.

## 2. Product concept

**GlassBox** is a thin observation plane alongside the existing execution path. It instruments the real seams (Fastify → `AgentService` → `AgentRunner` → runtime/container → Codex → workspace), normalises everything into one versioned `ObservationEvent` contract through a single redaction boundary, persists it locally, and exposes a Runs index and a Trace detail view with first-failure focus.

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
| Capturing chain-of-thought, full prompts/completions, raw headers, raw env | Privacy principle; `full/raw` capture policy is *prohibited*, not merely off |
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
| UX-01 | **Runs view**: columns status, Agent, start, duration, first failing step, event count, runtime/model, usage, redaction/degraded indicators; quick filters failed/running/cancelled/timed-out/degraded; keyboard-navigable rows; status as text + icon | Newest first; polling marks last observed event time |
| UX-02 | **Trace detail**: summary header; nested tree with duration bars, root + error path expanded by default; local filters (category/status/text/errors-only); span drawer; persistent first-error banner with *Jump to failing span*; trust badges (model/tool capability `observed | unavailable | unknown`, redacted), schema version, incomplete marker | Operator reaches failing span in ≤ 2 interactions |
| V-01 | **Verification**: unit (IDs, schema, ordering, span reconstruction, rollups, redaction, truncation, duplicates, incomplete), integration (Fastify→Service→Runner→store on success/timeout/error/cancel/restart/degraded store), privacy, E2E, regression, performance | All AC-01..07 automated where possible; `npm run check` green |

### 6.2 Nice-to-have (P1)
- **Usage & safe I/O summaries** (tokens from `turn.completed`, request/result summaries) only under `safe_summary` policy.
- **Export** `GET /api/traces/:traceId/export` — redacted, schema-versioned JSON identical in policy to the query response.
- **Capture policy config**: `metadata_only` (default) and `safe_summary` (opt-in local/demo); `full/raw` not implemented.
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

**Identifiers:** `traceId` (required, one per Run in MVP) · `spanId`/`parentSpanId` (root omits parent) · `runId` (required) · `agentId` (required) / `agentVersionId` (optional) · `sessionId` (= Codex thread id, when available) · `requestId` (required at ingress) · `actorId`/`actorType` (human | service | agent | controller; MVP `local-user`) · `attempt` (default 1) · `sequence` (monotonic per trace, required).

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

**Capture policy:** `metadata_only` (default: IDs, timing, status, names, counts, codes, sizes, flags) · `safe_summary` (opt-in: bounded, filtered, redacted summaries) · `full/raw` (**not implemented**).

**Evidence states:** `observed` (emitted by instrumented component) · `derived` (computed deterministically from stored facts) · `unavailable` (the Run completed and the component exposed nothing for that layer) · `unknown` (the Run was cancelled or timed out before that layer's stream said anything — absence proves nothing, so no `capability.unavailable` is emitted) · `redacted` · `truncated`. Per-layer capabilities (`model`, `tool`) take exactly `observed | unavailable | unknown`; the UI renders `unknown` as "no evidence — run cut short".

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

## 12. Six-day plan

| Day | Theme | Build | Exit gate |
|---|---|---|---|
| 1 | Contract & store | baseline run; schema/IDs/statuses (zod); `TraceStore` NDJSON + index rebuild; emitter; unit tests; capture raw Codex stream fixture | synthetic trace round-trips and rebuilds |
| 2 | Context & control seams | Fastify hook + `AgentService` adapter; link `AgentRun.traceId`; `/api/runs`, `/api/runs/:id/trace`; rollups | real successful Run has root + control spans |
| 3 | Runtime & privacy | runner adapters (container/Codex envelope, tool/file events if confirmed); redaction pipeline; capability flags; gated failure fixture; privacy tests | success/failure traces are truthful and safe |
| 4 | Product experience | Runs list; trace tree/timeline; filters; span drawer; failure banner + jump; polling | operator diagnoses failure ≤ 10 s |
| 5 | Robustness | restart/incomplete, store degradation, duplicates, caps, E2E, baseline regression, perf pass | acceptance suite green |
| 6 | Freeze & demo | P0 defects only; README, diagram, limitations, seed data, recording; rehearse ×2 | reproducible 3-minute proof |

**Team split (by contract, not layer):** backend contract (schema, store, query, rollup, redaction) · instrumentation (Fastify, AgentService, runners, failure fixture) · experience (Runs list, tree, drawer, filters, a11y) · verification/demo (fixtures, E2E/privacy/perf tests, docs, rehearsal).

**Cut order if slipping:** live streaming → export/retention UI → model/tool visualisation when unavailable → aggregate charts. **Never cut:** redaction, real backend instrumentation, controlled failure, baseline regression, trace detail path.

## 13. Demo script (3 min)

| Time | Beat | Proof |
|---|---|---|
| 0:00–0:20 | Orient | Agent catalog/Playground; select or create one Agent |
| 0:20–0:55 | Successful Run | real task using runtime + workspace; let the backend finish |
| 0:55–1:30 | Evidence | open Trace: connected layers, timing, container metadata, workspace change, usage, trust badges |
| 1:30–1:55 | Controlled failure | run the gated deterministic failure through the same path |
| 1:55–2:25 | Diagnosis | error banner → jump to failing runtime/tool span; cleanup/terminal state |
| 2:25–2:45 | Privacy proof | seeded fake secret was in the input; absent from persisted/API/UI evidence |
| 2:45–3:00 | Platform arc | architecture: trace plane today; controller consumes the same facts tomorrow |

## 14. Roadmap (why the MVP is not throwaway)

`TraceStore` → event backbone (add DB/stream adapter, emitters unchanged) · rollups → state projection for a controller · failure focus → typed retryability → `RetryDecision` · observed usage → budgets · actor context → approvals/revocation/audit · single Run → task graph (`taskId`, dependency edges, attempts) · single agent → A2A (context propagation across agents). A future controller **never mutates observation facts**; it writes a linked `ControlDecision` (`decisionId, traceId, runId, controller version, evidence refs, policy version, action, alternatives, outcome`) and its action produces new *observed* spans.

## 15. Rubric alignment

| Dimension | Weight | GlassBox proof |
|---|---|---|
| End-to-end behaviour | 40 % | real task traverses UI → Fastify → AgentService → AgentRunner → runtime/workspace and returns a connected trace; real controlled failure diagnosed |
| Design & integration | 25 % | documented seams, baseline preserved, provider-neutral versioned contract, evidence separated from future control |
| Verification & robustness | 20 % | success/failure/privacy/restart/degradation tests, caps, idempotency, reproducible setup |
| Demo & reproducibility | 15 % | success → trace → failure → diagnosis → privacy proof, one-command local path |

**Narrative:** *Agents fail in ways logs cannot explain. GlassBox makes every Run auditable and diagnosable today, and turns that evidence into the control substrate for tomorrow's agent plane.*

## Appendix A — Locked decisions
MVP centre = single-Run observability + failure diagnosis · storage = NDJSON per Run behind `TraceStore` + rebuildable index · capture = `metadata_only` default, `safe_summary` opt-in, raw prohibited · update model = polling, SSE only after P0 · no Collector/DB/cloud dependency.

## Appendix B — Sources
TechJam 2026 Track 1 brief · Starter Kit `docs/ARCHITECTURE.md`, `docs/HACKATHON_EXTENSION_GUIDE.md` · OpenTelemetry traces, context propagation, GenAI semantic conventions (mapped later; internal schema stays authoritative).
