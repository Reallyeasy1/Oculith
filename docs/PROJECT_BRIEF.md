# GlassBox project brief

_State as of 27 August 2026 (main `236bfaf`). The status board changes hourly; the sprint table on epic #42 and `docs/SPRINTS.md` are the source of truth for scope and order._

## 1. What it is

**GlassBox** is an agent-reliability middleware built on the Volc Agent Launchpad starter kit for TikTok TechJam 2026, Track 1. It sits between the control plane and the runtime of an AI coding agent and answers, with evidence rather than inference: _what did the agent do, why did it fail, and did a configuration change make it worse?_

| Stage | What it means | State |
|---|---|---|
| **Instrument** | Every layer emits one versioned `ObservationEvent` contract: HTTP ingress → AgentService → runner → container → Codex stream → workspace | done |
| **Observe** | Per-Run trace tree with rollups, first-actionable failure, diagnosis, metrics, capability states, redaction before persistence | done |
| **Audit** | Actor / action / resource / outcome rows projected from stored events; sandbox denials as first-class evidence | done |
| **Verify** | Save a Run as a Regression Case, rerun it from the same starting state under a new configuration, flag PASS→FAIL as `REGRESSION` | in review |

- **Problem.** Agent Runs fail silently or opaquely: timeouts, sandbox denials, runtime crashes and model behaviour all look the same from the outside, and a prompt or config change cannot be shown to have caused a regression.
- **Concept.** Observability-first middleware: facts are captured once, at the seams, and every product surface (trace, audit, metrics, evaluators, comparison) is a projection of the same stored events. There is no second source of runtime truth.
- **Users.** Agent developer/operator (primary), platform maintainer, hackathon evaluator, and a future controller that consumes the facts.
- **Non-goals (MVP).** Capturing chain-of-thought or full prompts/completions; replacing Jaeger/Grafana/OTel; multi-tenancy/authz; a scheduler or policy engine; LLM judges or scoring; trace replay; requiring the cloud (the local POC is the judged path).

**History.** The repository started as _LaunchGuard_ (capability leases and a protected-action gateway, issues #1–#20, all closed). It was re-scoped to GlassBox on 26 August (epic #42): evidence, not control, is what the track rewards, and a controller would need the same facts later anyway (PRD G6).

## 2. Architecture

| Component | Description |
|---|---|
| Control plane | Fastify server (`apps/server`), JSON store, `AgentService` (Agents, Runs, busy rule, restart handling), `AgentRunner` abstraction |
| Runtime | Codex CLI 0.111 in a disposable Docker container per Run (`ContainerCodexRunner`: `--rm --init --cap-drop ALL`, no published ports), model via BytePlus Ark. The Agent workspace under `AGENT_WORKSPACE_ROOT` is bind-mounted |
| Web | React/Vite (`apps/web`): Agents sidebar, per-Agent Runs, All-runs overview, trace detail (tree, timeline, drawer, filters, audit tab), live polling |
| GlassBox core | `apps/server/src/glassbox/`: zod schema (`SCHEMA_VERSION "1.0"`), non-blocking sequenced emitter with degraded mode, redaction pipeline (fails closed), NDJSON `TraceStore` per Run with a rebuilt index, `buildTrace` query/rollup, `CodexObserver` stream mapper; evaluators and the sandboxed post-check runner live alongside |

**Observation contract (PRD §8).** `schemaVersion · eventId · sequence · timestamp · traceId · runId · agentId · sessionId? · requestId? · spanId · parentSpanId? · type · category (control | runtime | infrastructure | tool | model | workspace | sandbox | policy | experience) · phase (start | end | instant) · status (running | ok | error | timeout | cancelled | unset) · actorType/actorId (human/local-user, agent/<id>, service/runner | sandbox | server) · source { component, adapter?, observed } · attributes (bounded metadata) · summary? (only under safe_summary) · error? · privacy { redacted, rulesetVersion }`.

**Invariants (`.claude/rules/glassbox-invariants.md`).**

- Redact before persist, fail closed; seeded fake secrets are swept from NDJSON, API, UI DOM, export and logs in the E2E lane.
- Never fabricate evidence: absence is `unknown`, not `unavailable`; incomplete spans stay incomplete; restart-cancels are labelled as such.
- Telemetry is non-blocking: a broken trace store yields `telemetry.degraded`, never a failed Run.
- Baseline preserved: the starter kit's acceptance flow and `npm run check` stay green.
- Versioned contract: additive changes only. Bumping `SCHEMA_VERSION` makes stored traces unreadable, so it is not bumped.

**Surfaces.** `GET /api/runs` (list with metrics, denials, configHash, capabilities, workspace changes, audit action count) · `/api/runs/:id/trace` · `/api/traces/:id/events?category=…&status=…` · `/api/traces/:id/export` (redacted JSON) · `/api/runs/:id/audit` · workspace/template routes and eval routes (in review). Capture policies: `metadata_only` (default) and `safe_summary` (512-character redacted command heads).

## 3. What is built (merged to main)

| Area | Delivered | Issues |
|---|---|---|
| Contract & store | Schema, IDs, taxonomy; NDJSON store and index; non-blocking emitter with degraded mode; redaction pipeline; retention with truncation reported; duplicate-event and restart semantics | #21 #22 #23 #29 #33 #39 |
| Instrumentation | Trace context at the Fastify boundary; AgentService lifecycle facts; runner/container/Codex envelope; tool and model mapping from the Codex `--json` stream; capability flags; `policy.denied`; workspace pre/post snapshot (`workspace.changed`); configHash on every Run; actor attribution (agent / runner / sandbox / server); sandbox briefing rules for Agents | #24 #25 #26 #28 #81 #67 #79 #135 #97 |
| Query & rollups | Runs list, trace, event filters, export; failure focus and diagnosis with exit-code hints; per-Run metrics; audit projection; restart-interrupted handling; OTLP mapping adapter | #27 #38 #74 #82 #101 #133 #41 |
| Web | Per-Agent Runs and All-runs overview; trace tree/timeline/drawer/filters; first-error banner with Jump; trust/evidence chips; audit tab; live refresh; first-load fixes; visual polish; attention rule with `recovered` chips and a Live strip; three capability states | #31 #32 #70 #72 #73 #87 #98 #99 #131 #60 |
| Verify foundations | Deterministic evaluator registry (`terminal_status`, `expected_tool`, `max_tool_calls`, `max_duration_ms`, `post_check`, `files_changed`); sandboxed post-check runner | #83 #80 |
| Verification & docs | E2E lane (Playwright, 96 checks: real ok Run, gated timeout fixture, privacy sweep, performance p95, restart, audit); PRD v3 with §16 Verify and the sprint timeline; guard self-test (48 cases) inside `npm run check` | #34 #30 #104 #76 #143 |
| Team workflow | Issue claims with race-safe tokens, session-owned branches, serialized merges through `merge-prs.sh` gated on a `## Review — Mergeable` comment, hooks that block `gh pr merge`, pushes to main and branch deletion | #76 |

## 4. Sprint plan

Sprints are scope units, not days — several can close in one day. One milestone (**TechJam MVP**), labels `sprint:S1…S8`, workstreams `ws:A` starting state & docs · `ws:B` evidence · `ws:C` eval · `ws:D` UI · `ws:E` verification/PRD/demo/submission. The full table with entry/exit gates and status is in `docs/SPRINTS.md`.

```text
S0 ▶ S1 ─┬─ S2 (evidence + demo-visible UI) ─────────────────┬─ S6 (verify) ─┬─ S7 (demo) ─ S8 (submission)
         └─ S3 (starting state) ─ S4 (case) ─ S5 (execute+compare) ┘
```

- **Critical path:** S3 (#64 → #68) → S4 (#84) → S5 (#105 → #85 → #86 → #89) → S7 (#92) → S8 (#94, #95). Every S3–S5 item has a PR; they are stacked #106 → #123 → #127 → #128 → #142 → #144 and land in that order.
- **Cut order if time runs out:** #67 (already done) → #80 → #89 → #87. Never cut #79, #81, #84, #85, #86 or #92.
- **Demo script (PRD §13, nine steps, ≤ 3 minutes):** start a Run from the Repo Doctor template → open its trace → show the first failure or a sandbox denial in the audit → save the Run as a Regression Case with assertions prefilled from evidence → change only the Agent's instructions → rerun as an EvalRun from a fresh copy of the same template → the comparison flags PASS→FAIL as `REGRESSION` with links to both traces. AC-08 reproduces this without network or model judgement inside `npm run check` (#91).

## 5. Backlog by priority (open at the time of writing)

| Priority | Issues |
|---|---|
| P0 | #129 model-turn spans · #130 tool-call spans and identity · #90 extend middleware verification · #92 demo fixture and runbook · #35 README · #93 architecture document · #94 pitch and script · #95 video |
| P1 | #64 #68 (S3) · #84 #88 (S4) · #105 #85 #86 #89 (S5) · #91 (S6) · #100 #102 (UI) · #132 outcome line · #134 baselines · #136 restart honesty · #138 drawer overlap · #54 #59 review follow-ups |
| P2 / deferred | #137 chip semantics · #103 a11y · #75 logs · #37 safe_summary usage · #40 SSE · #65 #66 workspace browser and editing · #96 workspace preview port · #36 workshop decisions |

**Recommended order after the Verify chain lands:** #129 + #130 (runtime timeline — the single biggest observability gain) → #132 (outcome line) → #88 / #89 (Verify UI) → #92 (demo) → #91 / #90 (verification) → #134 → S8 documentation and video.

**UAT round 3 (27 August) in one paragraph.** Five live scenarios showed the control layer is complete and honest, and named three gaps: `ok` means the process exited 0, not that the task succeeded (#131 shipped, #132 open); model time and tool identity are invisible inside `codex exec` (#129, #130); and nothing relates a Run to its Agent's history (#134). Smaller items: #133 (shipped), #135 (shipped), #136, #137, #138.

## 6. Working agreements

- **Plan before code.** Every implementation issue cites a PRD id; the sprint table on #42 is the source of truth for scope and order.
- **Claim, then branch.** `bash scripts/dev/claim-issue.sh N` assigns the issue and posts a race-safe claim token; branches are `feat|fix/N-slug`; the guard hook refuses branches for unclaimed issues and blocks a second session on the same issue. `release-issue.sh N --review|--abort` when done.
- **Every PR gets an adversarial review** posted as a comment starting `## Review — Mergeable` or `## Review — Blocked`, with Blocking / Follow-ups / Verified / Merge-order sections, file:line references, and a merge-tree check against current main.
- **Merges only through** `bash scripts/dev/merge-prs.sh <pr…>` (requires the Mergeable verdict; retargets stacked PRs before deleting the head branch). `gh pr merge`, pushes to main, force pushes and branch deletion are blocked by hooks.
- **Controller follow-ups.** When a blocker is bounded and on the critical path, the controller fixes it on the author's branch, notes it on the PR, and re-posts the verdict with evidence.
- **Toolchain gate before landing:** typecheck, server vitest, web vitest, vite build; the full E2E lane after each batch on main.
- **Secrets.** Never print or commit `.env`; API keys never reach argv or traces; the commit hook scans for secrets; `.local/` and `codex-home/` are off limits.
- **Windows quirks** are documented in `docs/LOCAL_POC.md` and the rules files (CRLF-aware conflict resolution, the `/tmp` container-runner test, the POC start command with `MSYS_NO_PATHCONV=1`).

## 7. Risks and open decisions

| Item | Why it matters | Proposed resolution |
|---|---|---|
| The Verify chain is one long stack | Six PRs land in strict order; a blocker at the base (#106) holds S3–S5 | Controller is fixing #106/#123. Decision needed: fix #142/#144 blockers as controller follow-ups (fastest) or hand them back to the author |
| Runtime-layer blindness (#129/#130) | Model time and tool identity are invisible; weakens the demo's "why did it fail" beat | Start immediately after the chain lands; observer-only, no contract break |
| `safe_summary` as the POC default | Without it, tool rows have no identity under `metadata_only` | Product decision: enable in `npm run poc` once #130's `argument0` exists, or keep `metadata_only` and rely on #130 |
| Deep-link / responsive / a11y PRs | UX-03 items are author-blocked; the demo runs on a laptop | Ask authors for the three small fixes; #138 (drawer) is filed separately |
| Demo determinism (#92) | Real Codex Runs take 20–180 s and vary; the 3-minute script needs a fixture path | Repo Doctor template, controlled denial, candidate instruction change, recorded backup video (#95) |
| Restart evidence (#136) | Interrupted Runs understate lifetime; cold start vs slow model indistinguishable | Heartbeat and first-output event; small |

## 8. Links

- Epic #42 (sprint table pinned) · milestone "TechJam MVP" · `docs/SPRINTS.md`
- PRD v3: `docs/PRD.md` (§6 requirements, §8 contract, §13 demo, §16 Verify)
- Rules: `.claude/rules/glassbox-invariants.md`, `.claude/rules/parallel-work.md`
- Scripts: `scripts/dev/{claim-issue,release-issue,merge-prs,test-guards}.sh`, `scripts/e2e/`, `scripts/start-local-poc.sh`
- Related docs: `docs/ARCHITECTURE.md`, `docs/LOCAL_POC.md`, `docs/CODEX_EVENTS.md`, `docs/DEPLOYMENT.md`
