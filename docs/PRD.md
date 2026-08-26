# PRD — GlassBox: observability-first middleware for Agent Runs

| | |
|---|---|
| **Track** | TikTok TechJam 2026 · Track 1 "Agent Launchpad: Design and Build Lightweight Agent Middleware" |
| **Repo** | github.com/Reallyeasy1/Oculith (built on the RrankPyramid/CodeJam Starter Kit) |
| **Status** | Draft v3 — 26 Aug 2026 (Observe + Audit + Verify) |
| **Source** | *GlassBox Observability PRD* (25 Aug 2026) + Track 1 problem statement §1.1–1.12 |
| **Decision** | **Ship evidence before control.** Single-Run observability and failure diagnosis are the MVP; orchestration is roadmap. |
| **Horizon** | Sprint plan S0–S8; see [SPRINTS.md](SPRINTS.md) |

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
| UX-01 | **Runs views**: per-Agent and All-runs views; columns status, Agent, start, duration, first failing step, event count, runtime/model, usage, and trust indicators; quick filters; keyboard-navigable rows; status as text + icon | Newest first; one polling loop keeps the list and an open trace consistent; All-runs aggregates across Agents |
| UX-02 | **Trace detail**: fixed summary header; nested tree/timeline; local filters; span drawer; persistent first-error/denial banner with *Jump to failing span*; capability states exactly `observed | unavailable | unknown`; redaction/truncation/degradation/incomplete evidence; `endedReason=server_restart` is explicit | Operator reaches failing evidence in ≤ 2 interactions; no absent evidence is presented as observed |
| UX-03 | **Reliable demo shell**: truthful disposable-workspace guidance, quiet first load, live refresh, laptop-width layouts, restart wording, deep links and keyboard focus | A cold load never shows a false warning or hides existing Runs; externally started Runs and terminal trace state appear within one polling tick |
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

**Evidence states:** `observed` (emitted by instrumented component) · `derived` (computed deterministically from stored facts) · `unavailable` (the Run completed and the component exposed nothing for that layer) · `unknown` (the Run was cancelled, timed out, or its stream never started — including error Runs that died before the first stream event — so that layer said nothing; absence proves nothing and no `capability.unavailable` is emitted) · `redacted` · `truncated`. Per-layer capabilities (`model`, `tool`) take exactly `observed | unavailable | unknown`; the UI renders `unknown` as "no evidence — run cut short".

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

## 12. Sprint plan

The authoritative S0–S8 schedule, issue membership, gates, lanes and critical path live in [docs/SPRINTS.md](SPRINTS.md). S0 is the completed observation plane. S1 pins the Verify contracts before S2–S5 build evidence, starting state, cases, execution and comparison; S6 verifies the complete loop; S7 rehearses; S8 packages the submission.

**Team split (by contract, not layer):** runtime/starting state (A) · trace/audit (B) · evaluation (C) · experience (D) · verification/submission (E).

**Cut order if slipping:** #67 → #80 → #89 → #87. **Never cut:** #79 config identity, #81 denial evidence, #84 Regression Cases, #85 EvalRun, #86 comparison, or #92 deterministic demo proof. Existing privacy, real instrumentation, baseline regression and trace-detail guarantees remain non-negotiable.

## 13. Demo script (3 min)

| Time | Step | Beat | Proof |
|---|---:|---|---|
| 0:00–0:15 | 1 | Orient | Open the Demo Agent and Repo Doctor starting-state template; the shell is ready without false warnings |
| 0:15–0:38 | 2 | Run | Submit the repair task through the ordinary AgentService/runtime path |
| 0:38–0:58 | 3 | Trace | Open the Run: connected control/runtime/tool evidence, timing, usage and trust states |
| 0:58–1:18 | 4 | Failure and denial | Jump to the failed check and the sandbox's `policy.denied`; diagnosis names the observed cause without raw content |
| 1:18–1:38 | 5 | Save case | Save this Run as a Regression Case; prompt, template/config identity and deterministic assertions are prefilled |
| 1:38–1:52 | 6 | Change configuration | Edit the candidate Agent instructions so it skips the expected verification step |
| 1:52–2:15 | 7 | Rerun | Run the same case through AgentService in a fresh template workspace and fresh thread |
| 2:15–2:42 | 8 | Compare | Compare baseline and candidate assertion results; evidence links open the exact Runs/traces |
| 2:42–3:00 | 9 | Regression | Show `REGRESSION` for PASS→FAIL, then close on the Audit → Verify architecture and privacy boundary |

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

## 16. Verify: Audit → Regression Case → EvalRun → Comparison

The Verify loop consumes the observation contract; it never creates a second source of runtime truth. A saved case records a bounded task and starting-state reference, a candidate rerun travels through the real AgentService/AgentRunner seams, deterministic evaluators cite observed evidence, and comparison classifies assertion transitions.

| ID | Requirement | Acceptance |
|---|---|---|
| FR-12 | **Configuration identity:** compute a deterministic `configHash` from behaviour-affecting Agent/runtime configuration and stamp every `run.created`, Run list row and trace summary | Same effective configuration gives the same hash; a relevant change gives a different hash; secrets and machine-specific paths are excluded (#79) |
| FR-13 | **Denial evidence:** emit one `policy.denied` alongside a sandbox-declined tool outcome, with service/sandbox actor and bounded metadata; count and focus denials | Audit and trace identify the declined program; no raw command/output under `metadata_only` (#81) |
| FR-14 | **Audit projection:** derive actor/action/resource/outcome rows from stored control, policy, sandbox and terminal runtime events; every row links to its source event and trace | `GET /api/runs/:id/audit` and trace audit routes return no fabricated rows; summary exposes counts only (#82, #87) |
| FR-15 | **Per-Run metrics:** derive bounded duration, tool/model/error/denial counts and token usage from the same events used by the trace summary | Metrics are deterministic, visible in list/detail, and equal direct event counts (#74) |
| FR-16 | **Regression Case and starting state:** save a Run as a case with bounded prompt, baseline Run/config, workspace-template reference and deterministic assertions; named/template workspaces reproduce the same starting state | Save-from-Run pre-fills evidence-backed assertions; reruns never mutate the baseline workspace (#64, #68, #84, #88) |
| FR-17 | **Deterministic evaluators:** support `terminal_status`, `expected_tool`, `max_tool_calls`, `max_duration_ms`, `post_check`, and `files_changed` only when cheaply observed | Each result is pass/fail/unavailable with evidence references; `post_check` runs in the sandbox, never on the host (#80, #83) |
| FR-18 | **EvalRun through AgentService:** execute cases serially as ordinary Runs against current candidate configuration in a fresh template workspace and fresh Codex thread | Agent workspace/thread remain untouched; trace carries case/eval identifiers and FR-12 hash; busy and cleanup semantics remain intact (#105, #85) |
| FR-19 | **Baseline/candidate comparison:** compare per-assertion outcomes and classify PASS→FAIL as `REGRESSION`, FAIL→PASS as improvement, and equal outcomes as unchanged; link both Runs/traces | Comparison table and summary agree; no score is generated by an LLM (#86, #89) |

### 16.1 Acceptance scenario AC-08 — save → rerun → REGRESSION

1. Run the Repo Doctor fixture from its named template and observe a passing baseline with a stable FR-12 hash.
2. Save the baseline as a Regression Case with an expected tool and post-check assertion.
3. Change only the candidate Agent instructions so the verification step is skipped.
4. Start an EvalRun. It provisions a fresh copy of the same template and a fresh thread, then executes through AgentService.
5. The candidate fails exactly one deterministic assertion; comparison marks PASS→FAIL as `REGRESSION` and links the baseline/candidate evidence.
6. The integration fixture reproduces the sequence without network/model judgement and the complete path remains covered by `npm run check` (#90, #91, #92).

### 16.2 Verify non-goals

- No LLM judge or probabilistic score.
- No trace replay: a rerun is new execution from a versioned starting state.
- No cross-model tournament or model router.
- No policy engine, approval workflow or control-plane mutation of observation facts.

### 16.3 TechJam MVP traceability

| Requirement | Milestone issues |
|---|---|
| FR-01…FR-11, UX-01/02, V-01 | #21–#35, #38, #39, #60, #69, #70, #72, #76, #93 |
| FR-12 | #79 |
| FR-13 | #81 |
| FR-14 | #82, #87 |
| FR-15 | #74 |
| FR-16 | #64, #68, #84, #88 |
| FR-17 | #67, #80, #83 |
| FR-18 | #85, #105 |
| FR-19 | #86, #89 |
| UX-03 | #97, #98, #99, #100, #101, #102, #103 |
| V-01, AC-08 | #90, #91, #92, #94, #95, #104 |

## Appendix A — Locked decisions
MVP centre = single-Run observability + failure diagnosis · storage = NDJSON per Run behind `TraceStore` + rebuildable index · capture = `metadata_only` default, `safe_summary` opt-in, raw prohibited · update model = polling, SSE only after P0 · no Collector/DB/cloud dependency.

## Appendix B — Sources
TechJam 2026 Track 1 brief · Starter Kit `docs/ARCHITECTURE.md`, `docs/HACKATHON_EXTENSION_GUIDE.md` · OpenTelemetry traces, context propagation, GenAI semantic conventions (mapped later; internal schema stays authoritative).
