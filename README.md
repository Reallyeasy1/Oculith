# Oculith — GlassBox

**TikTok TechJam 2026 · Track 1 "Agent Launchpad" · selected middleware track: Glass Box (observability).**
Built on the CodeJam Starter Kit (React Playground + Fastify control plane + Codex CLI on the
Volcengine/BytePlus Ark Responses API); GlassBox is the middleware layer this team added on top.

## Problem statement (Track 1)

A Run on the starter kit is a black box: the Playground shows a final message or a one-line error, but
nothing connects the HTTP request, service state transitions, the runner process/container, Codex's own
event stream, and the terminal result. When something fails, an operator cannot tell **which layer**
failed — and the naive fix (dump everything to a log) turns observability into a secret-leak liability.
Track 1 leaves "trace timeline" and "audit model" as intentionally absent middleware; GlassBox fills
that gap. Full statement: [docs/PROBLEM_STATEMENT.md](docs/PROBLEM_STATEMENT.md) · spec: [docs/PRD.md](docs/PRD.md).

## Product thesis: instrument → observe → audit → verify

Ship **evidence before control**. Every Run becomes one correlated, privacy-safe trace; everything else
is derived from those stored facts and never invented:

| Plane | What it gives you |
|---|---|
| **Instrument** | The real seams (Fastify → `AgentService` → `AgentRunner` → runtime container → Codex → workspace) emit one versioned `ObservationEvent` contract through a single redaction boundary |
| **Observe** | Runs list + trace detail (tree, timeline, span drawer) with first-failure focus and per-layer capability honesty |
| **Audit** | Actor/action/resource/outcome rows and sandbox `policy.denied` evidence, every row linked to its source event |
| **Verify** | Save a Run as a Regression Case → rerun it as an isolated EvalRun → deterministic comparison that classifies PASS→FAIL as `REGRESSION` |

Three vocabularies are kept distinct everywhere: *observed fact* · *derived diagnosis* · *evaluator
judgement* (PRD §17.1). No LLM writes a diagnosis or classifies a regression.

## Architecture

![GlassBox architecture](docs/assets/architecture.png)

*(Diagram being refreshed in #206.)* Component and extension boundaries:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Runtime flow in one line: Web UI → Fastify control plane → `AgentService` → `AgentRunner`
(`local-process` or disposable `container`) → Codex CLI → Ark Responses API, with GlassBox observing
every seam into per-Run NDJSON traces plus an in-memory index.

## Middleware boundaries: instrumented vs derived

| Instrumented (facts, emitted at the seams) | Derived (computed from stored facts only) |
|---|---|
| HTTP boundary: `http.request.received`, trace/actor context | Rollups: status, duration, counts, usage totals |
| `AgentService` lifecycle: run created/queued/completed, cancel, restart truth | First-failure focus + deterministic diagnosis text |
| Runner envelope: process/container start, timeout, SIGTERM→SIGKILL, `docker rm --force` cleanup | Audit projection (actors, actions, outcomes) |
| Codex JSONL stream: tool calls with duration/exit code, model calls, token usage, reasoning-token counts | Per-Run metrics, baselines, reliability aggregates |
| Sandbox denials as `policy.denied` | Evaluator results and baseline/candidate comparison |
| Workspace disk truth (bytes/files) | Capability states per layer: `observed` / `unavailable` / `unknown` — absence is never guessed |

Adapters live in the existing starter-kit seams; GlassBox server code is `apps/server/src/glassbox/`
(context, emitter, redact, store, query).

## Setup

Requirements: Node.js 22+, npm 10+, Docker (or Colima/Podman), an Ark API key + Responses-capable
endpoint ID. Codex CLI is included in the Runtime image.

```bash
node --version
npm --version
docker --version
git clone https://github.com/Reallyeasy1/Oculith
cd Oculith
npm ci
cp .env.example .env    # then set ARK_API_KEY, ARK_MODEL, APP_AUTH_TOKEN (24+ random chars)
```

An empty `APP_AUTH_TOKEN` disables auth entirely; the demo sets 24+ random characters, entered once in
the browser unlock screen.

## Run it

### One command (judged path)

```bash
ARK_API_KEY=your-ark-api-key \
ARK_MODEL=ep-your-endpoint-id \
npm run poc
```

Builds the Runtime image, auto-selects Docker/Colima/Podman, runs each turn in a disposable container,
and serves <http://localhost:3000>. `Ctrl+C` stops it; workspaces and conversations are kept
(macOS `~/.volc-agent-launchpad/`, Linux `.local/`, or `LOCAL_POC_DATA_ROOT`). Force an engine with
`CONTAINER_ENGINE=podman` (Colima uses `docker`). Rootless Podman: [docs/LOCAL_POC.md](docs/LOCAL_POC.md#rootless-podman-on-linux).
Note: `npm run poc` reads the **shell environment**, not `.env` (`set -a; . ./.env; set +a` first).

**Windows:** npm hands scripts to `cmd.exe` and Git Bash mangles `dst=/workspace` mount paths, so run
the same script directly from Git Bash:

```bash
MSYS_NO_PATHCONV=1 LOCAL_POC_DATA_ROOT="C:/<abs-path>/Oculith/.local" bash scripts/start-local-poc.sh
```

(with `ARK_*` exported). Verified 2026-08-26: the baseline acceptance task completes in ~70 s in a
disposable container. On Docker Desktop the kernel lacks Landlock, so the script falls back to
`CODEX_SANDBOX_MODE=danger-full-access` inside the outer container — expected, documented in
`.env.example`; see [Known limitations](#known-limitations).

### Development mode

```bash
npm ci
cp .env.example .env
npm install --global @openai/codex@0.111.0   # codex on PATH for RUNTIME_PROVIDER=local-process
npm run dev
```

Web UI <http://localhost:5173>, API <http://localhost:3000>. Use local paths in `.env` outside Docker:
`APP_DATA_DIR=.data`, `AGENT_WORKSPACE_ROOT=workspaces`, `CODEX_HOME=codex-home`.

### Docker Compose / deployment

`docker compose up --build` (stop with `docker compose down`; data survives). Optional PostgreSQL
summary backend: `docker compose --profile postgres up` with `GLASSBOX_STORE=postgres`. Volcengine ECS
and Terraform paths: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — the judged path is local.

## Demo

Full rehearsal runbook: [docs/DEMO.md](docs/DEMO.md) *(being authored in #92)*. The 3-minute script is
PRD §13. Short version:

1. `.env`: `APP_AUTH_TOKEN` set (24+ chars), `GLASSBOX_CAPTURE_POLICY=safe_summary` (so the Outcome
   column carries the Agent's final line), `GLASSBOX_DEMO_FAILURE=off`. The server reads these once at
   boot — every change needs a restart.
2. Start the server, seed one ok Run: `bash scripts/seed-demo.sh ok` (creates the **Demo** Agent if
   missing, sends one real task, prints the run id — never the token).
3. Set `GLASSBOX_DEMO_FAILURE=timeout` → restart → `bash scripts/seed-demo.sh fail` → the Run times out
   after 3 s through the real Run path → set it back to `off` → restart.
4. Open <http://localhost:3000>, unlock with the token → **Demo** Agent → the failed Run tops
   **Needs attention** → open its trace → **Jump to failing span** → trust badges.

The failure fixture adds no failure path of its own: it only overrides `CODEX_TIMEOUT_MS` to 3 s for
the next Run, which then takes the ordinary runner timeout (SIGTERM→SIGKILL for `local-process`,
`docker rm --force` for `container`) and ends in `run.timed_out`. It is off by default and never
enabled by `npm run poc`.

![Agent Playground](docs/assets/playground.jpg)

## Observability behaviour

**Trace.** One append-only NDJSON file per Run (30 event types across 9 categories): stable
`traceId/spanId/runId/agentId/sessionId/requestId/actorId/sequence`, per-turn token usage (input,
cached-input, output, reasoning), per-call `modelCallsObserved`, bounded tool identities with durations
and exit codes, workspace disk truth, `configHash` on every Run. Trace detail = fixed summary header,
nested tree/timeline, span drawer, local filters, persistent first-error banner with **Jump to failing
span**. Export (`GET /api/traces/:traceId/export`) is byte-identical in policy to the query response.

**Per-layer capabilities.** Model/tool evidence has exactly three states and is never guessed:
`observed` (the runtime emitted events for that layer), `unavailable` (the Run completed and the
runtime exposed no detail — emits `capability.unavailable`), `unknown` (cancelled/timed out/stream
never started, so absence proves nothing). An ok Run with zero tool calls shows a neutral
`no tool calls`, not a warning.

**Capture policies.** `GLASSBOX_CAPTURE_POLICY=metadata_only` (default) stores IDs/timing/status/counts
only; `safe_summary` adds four bounded, redacted text fields (including the Outcome line — the demo
sets `safe_summary`; the default keeps that column empty by design); `reasoning_summary` (opt-in, #259)
adds everything `safe_summary` does plus one `model.reasoning` event per observed reasoning item,
carrying only a 240-char redacted summary. `full`/raw capture is prohibited by PRD §4, not merely
unimplemented.

**Metrics and reliability.** `POST /api/metrics/query` answers one aggregate question over a fixed
metric catalogue (completion/failure rates, tool calls, tokens, latency, denials, task completion —
telemetry and evaluation metrics labelled apart, nearest-rank percentiles, every response carries
`provenance`). `GET /api/agents/:id/reliability` and `GET /api/reliability/compare` shape the same
semantics for the dashboard, so the two APIs can never disagree on the same window.

## Audit, failure and denial behaviour

- **Audit:** `GET /api/runs/:id/audit` derives actor/action/resource/outcome rows from stored control,
  policy, sandbox, tool and terminal events — no fabricated rows; every row links to its source event.
- **Failure:** first actionable error + causal path; timeout, cancellation, runtime failure, model
  failure, tool failure and platform degradation are distinguished; diagnosis text is deterministic,
  built only from stored facts. Exit-code hints (127, 137, …) appear on the failure banner.
- **Denials:** a sandbox-declined tool outcome emits `policy.denied` with the declined program and
  bounded metadata (no raw command/output under `metadata_only`); denials are counted, focused, and
  surfaced in audit. `ok ≠ success`: `executionStatus` and `taskOutcome` are separate columns.
- **Degradation:** if the trace store fails, the Run still completes and the gap is visible as
  `telemetry.degraded`; after a server restart, in-flight Runs show as cancelled with open spans marked
  `endedReason=server_restart` — never silently closed. On redactor error the event is persisted as
  metadata only (`privacy.reason=redaction_failed_closed`).

## Regression workflow (Verify)

Save case → rerun → compare, all through the real Run path:

1. **Save** a Run as a Regression Case: bounded prompt, baseline Run/config, workspace-template
   reference with a **template content hash**, and deterministic assertions pre-filled from evidence
   (`terminal_status`, `expected_tool`, `max_tool_calls`, `max_duration_ms`, `post_check`).
2. **Rerun** as an EvalRun: a fresh copy of the same template and a fresh Codex thread, executed
   serially through `AgentService` against the candidate config — the baseline workspace and thread are
   never mutated. Template hashes are stamped on the case and the EvalRun; an edited template is a
   mismatch, not a silent drift.
3. **Compare** baseline vs candidate per assertion: PASS→FAIL is classified `REGRESSION` (FR-19);
   FAIL→PASS and unchanged are shown but not scored. Both traces are linked as evidence.

A rerun is new execution from a versioned starting state — **not** an exact replay (see limitations).

## Automated testing

| Command | What it proves |
|---|---|
| `npm run check` | typecheck + vitest (server + web view-models) + guard self-test + build. Includes the model-free regression integration fixture (#91): the full save → rerun → `REGRESSION` sequence through a fake runner, no network or model |
| `npm run test:e2e` | The judged configuration end to end (Docker runtime image, production mode, Playwright on installed Chrome): create Agent → real model task → trace walkthrough → gated failure with container-cleanup evidence → seeded-secret sweep across every NDJSON file, API response, export, server log and the rendered DOM → append/query p95 bounds. Needs Docker, Chrome and an Ark key; 2–4 min |

E2E details: it starts its own server on `:3100` with a throwaway state root, so a live `npm run poc`
on `:3000` is never touched. Playwright is deliberately not a dependency: run
`npx -y playwright@1.60.0 --version` once and point `PLAYWRIGHT_DIR` at the npx cache it created.

**Windows:** `npm run check` has 2 documented platform-artifact failures, not bugs (see `CLAUDE.md`):
a POSIX `/tmp` path assertion in `container-codex-runner.test.ts` always fails, and slow machines can
hit vitest's 5 s default timeout on a few more tests (those pass with `--testTimeout=30000`). The suite
is authoritative on Linux/macOS, where CI runs it. Shell scripts are bash — run them from Git Bash.

## Security and redaction

Covered:

- **Redact before persistence, fail closed.** One redaction boundary in front of disk, API, export and
  logs: allowlist of operational fields → case-insensitive key denylist (`authorization`, `apiKey`,
  `token`, `secret`, `password`, `cookie`, `privateKey`) → bounded pattern scan (bearer tokens, `sk-`,
  `ark-`, AK/SK pairs, private-key blocks, credential URLs) → truncation. If the redactor itself
  errors, only metadata is persisted.
- **No raw chain-of-thought, ever.** Reasoning *token counts* are recorded at every policy; raw
  reasoning text is never stored. Under the explicit opt-in `reasoning_summary` policy only, each
  reasoning item is kept as a 240-char redacted summary through the same pipeline — never by default
  (invariant 5, PRD §4).
- **No raw prompts/completions** at the default policy; `safe_summary`/`reasoning_summary` add only
  bounded, redacted summaries. The E2E lane sweeps seeded fake credentials across every persisted and
  rendered surface.
- API keys reach Codex only via explicit env allow-lists, never argv; child processes never inherit the
  full environment.

Not covered — know this before putting anything sensitive near it:

- **Workspace file contents are not redacted.** Whatever the agent writes into its workspace sits on
  disk as plain files; the trace records bytes/paths, but the workspace itself is outside the redaction
  boundary.
- **The shared bearer token is a demo secret, not identity.** One `APP_AUTH_TOKEN` for every route;
  no users, no authz — that is the Bouncer track, not this one.
- Redaction is exact on structured attributes and best-effort on free text; a novel secret format in a
  command string can slip past — which is why the default policy is `metadata_only`.
- Single-user proof of concept: do not use production data or credentials. See [SECURITY.md](SECURITY.md).

## Known limitations

- **Single runtime instance, single process.** `JsonStore` and the NDJSON trace store are
  in-memory-plus-file with no cross-process locking; run one server.
- **Templates are versioned starting states, not exact replay.** An EvalRun reruns the task from the
  template; it does not replay the original trace step by step.
- **No policy engine.** Denials are *observed* sandbox facts; nothing in GlassBox decides or blocks —
  controls are roadmap, written as linked `ControlDecision` records that never mutate observation facts.
- **Landlock fallback in Docker Desktop.** Kernels without Landlock (Docker Desktop on Windows/macOS)
  fall back to `danger-full-access` inside the outer container: the container boundary holds, per-Agent
  filesystem isolation inside it does not. Use a scoped demo model key.
- **Windows test artifacts.** 2 of the unit tests fail on Windows for platform-path/timeout reasons
  (documented in `CLAUDE.md`); Linux/macOS is authoritative.
- Local NDJSON only — no external backend; retention is a startup-only pass
  (`GLASSBOX_RETENTION_DAYS` / `GLASSBOX_MAX_DISK_MB`), and evicted Runs keep their metadata skeleton
  plus a `trace.truncated` tombstone (never silent deletion).
- `workspace.changed` takes the platform's before/after disk snapshot as ground truth on every
  Run; the stream-side file-change report is a fallback observed only when the model uses
  `apply_patch` — neither path invents a diff ([docs/CODEX_EVENTS.md](docs/CODEX_EVENTS.md)).
- Model/tool-level events are only emitted when the runtime genuinely exposes them; per-call latency /
  time-to-first-token is structurally unavailable from `codex exec` and is declared, not approximated.
- Agents cannot expose ports to the host; runnable build output stays in the workspace.

## Future work (deliberately deferred)

| Deferred | Where it stands |
|---|---|
| LLM judge / semantic evaluation | #171 (in review) — kept apart from deterministic Verify by design |
| Cross-model comparison / tournament | Explicit non-goal for the MVP (PRD §16.2) |
| OTLP / OTel GenAI mapping | #41 — adapter stub exists; internal schema stays authoritative |
| SSE live streaming | #40 — polling ships first, gated on P0 per PRD |
| Workspace browser | #65 / #66 |
| Run-log follow-ups | #243 |

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ARK_API_KEY` / `ARK_MODEL` | Required | Ark key + Responses-capable endpoint ID (`ARK_BASE_URL` defaults to BytePlus ap-southeast v3) |
| `MODEL_PROVIDER` | `ark` | `ark` or `openai` (`OPENAI_API_KEY`, optional `OPENAI_MODEL`) |
| `APP_AUTH_TOKEN` | Empty (auth off) | Bearer token for every `/api/*` route; production refuses non-loopback with <24 chars |
| `RUNTIME_PROVIDER` | `local-process` | `container` for disposable Runtime containers (`npm run poc` sets this) |
| `CODEX_SANDBOX_MODE` | `workspace-write` | Codex inner sandbox; falls back to `danger-full-access` without Landlock |
| `CODEX_TIMEOUT_MS` | `600000` | Maximum duration of one turn |
| `GLASSBOX_CAPTURE_POLICY` | `metadata_only` | Or `safe_summary` (bounded, redacted summaries + the Outcome column — the demo sets it), or `reasoning_summary` (safe_summary plus 240-char redacted reasoning summaries, #259); raw capture is not implemented. Summaries already persisted stay on disk and are served after a policy downgrade — mind that when lowering the tier |
| `GLASSBOX_DEMO_FAILURE` | `off` | `timeout` forces the 3 s demo failure through the real Run path |
| `GLASSBOX_TRACE_DIR` | `$APP_DATA_DIR/traces` | Per-Run NDJSON trace files |
| `GLASSBOX_RETENTION_DAYS` / `GLASSBOX_MAX_DISK_MB` | `7` / `200` | Startup-only compaction of finished Runs to terminal events + tombstone; `0` disables |
| `GLASSBOX_LOG_MAX_MB` | `50` | Run-correlated, redacted server log rotation (3 files kept) |
| `GLASSBOX_STORE` / `DATABASE_URL` | `json` / — | `postgres` keeps Run summaries in PostgreSQL (`docker compose --profile postgres up`); traces stay NDJSON |
| `GLASSBOX_PRICE_PER_MTOK_INPUT` / `_CACHED_INPUT` / `_OUTPUT` | — | Optional cost estimates; cached input defaults to the input rate |

Full list including container/resource limits: [.env.example](.env.example).

## Documentation

- [Track 1 problem statement](docs/PROBLEM_STATEMENT.md) · [PRD](docs/PRD.md) · [Architecture](docs/ARCHITECTURE.md)
- [Observability roadmap](docs/OBSERVABILITY_ROADMAP.md) — the stance on inputs, outputs and reasoning
- [UAT coverage](docs/UAT_COVERAGE.md) — what has been tested, how, and what remains
- [Local POC](docs/LOCAL_POC.md) · [Deployment](docs/DEPLOYMENT.md) · [Codex events](docs/CODEX_EVENTS.md)
- [Security policy](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Hackathon extension guide](docs/HACKATHON_EXTENSION_GUIDE.md)

## License

[MIT](LICENSE)
