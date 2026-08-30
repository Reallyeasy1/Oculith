# UAT coverage record

_What has been tested, how, and what has not. Last updated 30 August 2026 (main `620f609`). Automated coverage comes from `npm run check` (unit tests, guard self-test, build) and the E2E lane (`npm run test:e2e`); manual coverage comes from the nine UAT rounds below. This record is updated at the end of every UAT round._

## 1. UAT rounds

| Round | When | Lens | Method | Findings → issues |
|---|---|---|---|---|
| 1 | 26 Aug, afternoon | First run of the Observe half on the POC | Manual, browser + curl | Validation errors returned 500 in production (error handler registered after static) → fixed in #60; capability "unavailable" inferred from absence → third state `unknown` (#60) |
| 2 | 26 Aug, evening | Exploratory pass against the PRD | Playwright walkthrough, screenshots | Live refresh, first-load banner and empty table, layout at 1366/1024/800, restart wording, deep links, keyboard/a11y → #98, #99, #100, #101, #102, #103 |
| 3 | 27 Aug, 02:45–03:00 | Observability value: what does the trace tell an operator? | Four live scenarios through the API + Playwright, one forensic trace | ok ≠ success, model-time blindness, tool identity/duration, exit hints, baselines, live Runs hidden, audit actors, restart honesty, chip semantics, drawer overlap → #129–#138 ([report](https://claude.ai/code/artifact/25d8f2af-092f-45f7-b2a3-aaaf976f5435)) |
| 4 | 27 Aug, 14:40–15:20 | Feature surfacing: is every merged feature reachable? | API probes, Playwright walkthrough of dialogs and views, one template-backed Run driven end to end | "0 files changed" evidence bug (#153, fixed in #159), export API-only, workspace UUID column and free-text field, exit hints missing from the drawer, prefill create semantics, chip spacing → #153–#158; demo-fixture notes on #92 ([report](https://claude.ai/code/artifact/1baef811-f38c-4a3a-9107-ca297ed2429d)) |
| 5 | 28 Aug, 11:15–11:35 | The Verify chain through the real UI after #151/#152/#179/#189/#197/#125/#124 landed | Playwright (system Chrome) + API against a production build on the container runtime; 3 live Runs (Playground 43 s, two EvalRuns 34 s / 33 s), 25 screenshots | 30 checks: 27 pass, 2 fail, 1 not reachable. Save-case modal is not a modal (fixed same day), `ENOENT` path leak in the template 400 (fixed same day), Runs table 1527 px at 1366 → #199, cold-load "model not configured" flicker → #200, page-level scroll below 1366 + clipped brand → #201, template Runs always "Needs attention" + evidence re-scroll → #202 |
| 6 | 28 Aug, 13:45–14:10 | The 17 PRs merged after round 5 (tool/model spans, outcome line, restart honesty, exit hints, evidence chips, workspace picker, export link, drawer docking, keyboard, badges, prefill draft, run logs, baselines, evaluation store) plus the #210 restart-wipe hotfix | Playwright + API against a production build on the container runtime; 2 live Runs; 14 screenshots | 60 checks: 47 pass, 0 fail, 13 not reachable. Findings: the Outcome line is invisible under the default capture policy (runbook note added), the Logs panel carries only two lines per Run (#214), a shared managed workspace showed a raw UUID, exit 128/134/139/143 had no hint — all fixed or filed |
| 7 | 28 Aug, 18:40–19:20 | Post-merge verification of #224/#225/#227/#231 on the dev runtime (`local-process`, Windows, real Ark model), driven end to end through the browser | Playwright MCP against `npm run dev` (:5173 → :3000), `APP_AUTH_TOKEN` set; 3 live Runs (3m13s / 2m49s / 3m59s, 300–470k tokens each), 2 EvalRuns, 1 comparison; 4 screenshots | `modelCallsObserved` verified against production evidence (22 calls on a 321k-token single-turn Run — pre-#231 this read 1); per-layer Evidence badges ("model observed · tool observed"); EvalRun template-hash provenance on the case row; comparison view (No-regression branch, deltas, evidence links); Live strip during all runs; **real `policy.denied` evidence at last** (Windows local-process sandbox resolves to read-only → 20–25 denials/Run, first-denial focus card correct) — the round-4 "not demonstrable" note was container-path-specific. Findings: Logs panel carries only 2 lines/Run → #232 (fixed same day: #199 table containment, #200 cold-load flash, #233 favicon, #234 comparison mismatch banner all merged); runtime card label says "application container" while Runs say `local-process`; #202 noise confirmed (all ok Runs "Needs attention" via recovered chips) |
| 8 | 29 Aug, 15:22–15:24 | Current-main deterministic verification of three previously unreachable round-8 paths, without model inference | Isolated production build on `9ed61b6`, Fastify + real AgentService/CodexRunner parsing + JSON trace store, deterministic JSONL Codex executable, `safe_summary`, API on :3213; server container killed and restarted against the same data root | **PASS, no defects.** Exit codes 2/126/127/130/137 each persisted raw `exit code N` evidence and the correct operator hint in the reconstructed tool span. A safe-summary Run stored two bounded `model.message` events, used the final response for `summary.outcome.text`, redacted a seeded bearer canary in the command/output summary, and returned no raw canary from the trace API. A deliberately running Run survived an abrupt server-container kill as persisted `cancelled`; after restart the trace was `cancelled`, `/api/runs` reported `endedReason: server_restart`, `interruptedAfterMs: 5422`, and `firstFailingStep: codex exec`. UI rendering was not exercised; zero Ark calls. |
| 9 | 30 Aug, 23:35–23:41 | Browser presentation of the three API-only round-8 paths, plus the metadata-only reported-failure fallback | Isolated production build of PR #352 head `75602bb` on :3214; real AgentService/CodexRunner parsing and JSON stores; deterministic local JSONL executable; `safe_summary` and `metadata_only`; abrupt server-process kill and restart against the same state root; in-app browser | **PASS, no defects; zero Ark calls.** Run `f9d3865b-d534-4a5b-bfe3-09f171977a38` rendered `exit code 127 — command not found — the program is missing from the runtime image` on `shell:missing-uat-command`. Run `441deee6-0758-4851-9a85-8df05d7e4489` rendered `cancelled`, duration `≥ 20.3 s`, three incomplete spans, `tool: no evidence`, first actionable `codex exec`, and the server-restart diagnosis. Safe-summary Run `23688573-528a-418f-ad36-00d1705c1b0e` rendered the bounded 240-character Outcome with the same 240-character `title`; its `model.message` drawer showed `Checking [REDACTED:bearer] before continuing.` and no raw canary. Metadata-only Run `eae28bd5-b303-4488-805a-2303404fb764` rendered the `agent reported failure` chip and its derived-not-judgement tooltip. |

Scenarios driven in round 3 (all on the container runtime with deepseek-v4-flash): hello-world file + run (177 s, 9 tool calls, 2 failed); `curl` a URL in an image without `curl` (task failed, Run `ok`); run a missing script then create it (tool failure + recovery); a long task stopped after 12 s (cancel evidence); yesterday's restart-cut Run (forensic). Round 4 additionally created an Agent from the `node-lib-with-failing-test` template and had it fix the failing test (39 s, 5 tool calls, 1 recovered), then saved the Run as a Regression Case through the API.

## 2. Feature coverage

Legend — **Unit**: vitest in `apps/server` / `apps/web`; **E2E**: step of `scripts/e2e/driver.cjs`; **UAT**: manual round; **Result**: last observed state.

| Feature (issue) | Unit | E2E | UAT | Result |
|---|---|---|---|---|
| Observation schema, IDs, sequencing (#21) | schema, emitter, store tests | [2] shapes, [3] export = trace | 1–4 | ok |
| Trace store, index rebuild, duplicates (#22, #33) | store + integration tests | [5] restart | 3 (forensic), 4 | ok |
| Non-blocking emitter, degraded mode (#23) | emitter test (store throws) | — | — | **not exercised manually** |
| Redaction before persistence, fail closed (#29, #11) | redact tests with seeded fakes | [7] privacy sweep (files, API, export, log, DOM) | 8 (seeded bearer canary absent from trace API), 9 (redacted drawer; raw canary absent from DOM) | ok (automated + isolated current-main UAT) |
| Retention and eviction (#39) | store retention test | — | — | **not exercised manually** |
| Output cap `limit.exceeded` (#28) | runner test | — | — | **not exercised manually** |
| Trace context at the Fastify boundary (#25) | app tests | [2] | 3, 4 | ok |
| AgentService lifecycle facts, busy rule (#26) | agent-service tests | [2b] 409 while sibling busy | 3 (cancel), 4 | ok |
| Runner/container/Codex envelope (#28) | runner tests (Windows `/tmp` case fails, documented) | [2], [5] | 3, 4 | ok |
| Tool/model mapping from the Codex stream (#24, #28) | observer tests with recorded fixture | [2] tool events on the real Run | 3, 4 | ok; tool identity/duration gaps → #129, #130 |
| Gated timeout fixture (#30) | — | [5] `GLASSBOX_DEMO_FAILURE=timeout` | 3 (rows explained) | ok |
| Query API, filters, export (#27, #38) | query + app tests | [2], [3], [6] | 3, 4 | ok; export has no UI link → #154 |
| Runs view, filters, first failing step (#31, #70) | view-model tests | [4], [4b] | 2, 3, 4 | ok |
| Trace detail: tree, timeline, drawer, filters, Jump (#32, #72, #73) | view-model tests | [4], [6] | 2, 3, 4 | ok; drawer overlap → #138 |
| Restart / incomplete spans (#33, #101) | agent-service + integration AC-06 (wait-for-runner) | [5] | 3 (forensic), 8 (deterministic API restart), 9 (browser) | API and UI show honest persisted cancellation, interrupted duration, incomplete spans and restart diagnosis; duration semantics → #136 |
| Timeline axis and open-ended bars (#73) | view-model tests | — | 3, 4 | ok |
| configHash (#79) | agent-service + query tests | [2] export/summary | 3, 4 | ok |
| Per-Run metrics (#74) | query tests | [2] counts equal trace | 3, 4 | ok; `modelCalls` per-call via observed reasoning/message items (#207) |
| Policy denials (#81) | observer + query tests | — | — | **not demonstrable in the POC** (`danger-full-access`, no sandbox setting) → note on #92 |
| Audit projection and view (#82, #87) | query + app tests | [6] rows equal API | 4 | ok |
| Actor attribution (#135) | observer + query tests | — | 4 (new Run: agent/runner/human) | ok |
| Workspace changes (#67) | snapshot tests; query test with both emitters | — | 4 | **bug found and fixed** (#153 → #159), re-verified live |
| Sandbox briefing `AGENTS.md` (#97) | agent-service test | — | 4 (on disk) | ok |
| Live refresh, first load (#98, #99) | view-model tests | [4b] | 2, 3, 4 | ok |
| Attention rule, recovered chips, Live strip (#131) | view-model tests | [4b] identities, strip present iff running | 4 | ok |
| Exit-code hints (#133) | query tests | — | 4, 8 (2/126/127/130/137 through HTTP + stored trace reconstruction), 9 (127 in browser) | all listed codes format correctly in the trace API; exit 127 hint verified in the browser tree |
| Selectable workspaces (#64) | workspace + agent-service tests | [2b] create on shared name, 409, switch, `AGENTS.md`, `run.created.workspace` | 4 (Create/Settings fields, column) | ok; UUID label / free text → #155 |
| Workspace templates (#68) | workspace tests (wx writes, bad template) | — | 4 (form select; Agent created via API) | ok; **form submission with a template not driven through the UI** |
| Isolated eval Run (#105), EvalRun execution (#85) | agent-service + runner tests | — | 5 ("Run against" from the overview: running → 4/4 passed, `templateHashes` on the EvalRun) | ok |
| Regression cases + prefill (#84) | cases tests | — | 4 (API: prefill 4 assertions, create, list) | ok; prefill persists immediately → #158; no UI (#88) |
| Evaluators (#83), post-check runner (#80) | evaluator + post-check tests | — | 5 (4 inferred assertions evaluated on two EvalRuns) | ok |
| Regression case UI (#88), comparison UI (#89) | app test (derive with name/assertions); web view tests | [4] save dialog → case created | 5 (dialog assertions, overview case row, Compare banner vs tinted rows, evidence deep links into another and the open trace) | ok; modal a11y fixed; only the no-regression banner branch observed |
| Template content hash (#176) | agent-service tests (edit, rename, force, legacy, missing → 400) | — | 5 (hash recorded on the case and the EvalRun; unknown template → 400) | ok; **mismatch 409 not driven live** (needs an edited template) |
| RunSummary store, `executionStatus` / `taskOutcome` (#168, #191) | summary tests on JSON + PostgreSQL | [4b] | 5 (`/api/runs` rows: running/unknown → completed/unknown), 9 (bounded Outcome + metadata-only failure chip) | ok; 240-character Outcome/title and derived reported-failure fallback verified; Postgres backend booted and tested, not used in UAT |
| Trace deep links (#102) | view-model tests | — | 5 (`?run=` sync, reload reopens the trace, stale id falls back with no banner) | ok |
| Laptop layouts (#100) | — | — | 5 (1366/1024/800 screenshots) | partial: internal scroll + hint works, table still 1527 px → #199, page scroll below 1366 → #201 |
| OTLP mapping adapter (#41) | otlp tests | — | — | library only, deferred |
| Auth (bearer token) | app test | [1] 401 without token | — | **browser flow with auth on not clicked through** |
| Production error handling (#60) | app test (NODE_ENV=production) | [1] 400 on validation | 1 | ok |
| Performance bounds | vitest guards (20 ms / 500 ms) | [8] append p95 < 200 ms, query p95 < 500 ms | — | ok (3.8 ms / 36.6 ms on 27 Aug) |
| Workflow guards (#76) | `scripts/dev/test-guards.sh` (48 cases) | — | — | ok |

## 3. E2E lane steps (as of 28 Aug)

1. `[1]` production server with auth on: 401 without token; validation is 400 in production.
2. `[2]` baseline: create an Agent, run a real task on the real runner; `/api/runs`, trace, export shapes.
3. `[2b]` shared workspace: second Agent on the first's workspace name; `/api/workspaces` lists both; 409 while the sibling is mid-Run; `PATCH {workspace}` switch → `workspaceName`, `codexThreadId: null`, `AGENTS.md` in the new directory, `run.created.attributes.workspace` on the next Run; extra traces swept; Agent B deleted.
4. `[3]` export equals the trace body.
5. `[4]` UI: Runs table → Enter → tree → drawer → focus trap → Escape → filters → save dialog → regression case created → Close.
6. `[4b]` Runs follow the selected Agent; All runs spans Agents; summary strip identities (attention / recovered / running); Live strip present iff a Run is running.
7. `[5]` restart with `GLASSBOX_DEMO_FAILURE=timeout`: gated fixture through the real runner; `run.timed_out` names the 3000 ms timeout; no container left behind.
8. `[6]` Timed-out filter → banner → Jump lands in the drawer on the failing span; audit table rows equal the API; outcome rendered as text.
9. `[7]` privacy sweep: seeded fakes absent from files, API, export, log, DOM.
10. `[8]` performance: append p95 < 200 ms, query p95 < 500 ms.

Last green run: **180 checks** on `main` `3c99341` (28 Aug, after the 25-PR merge; an earlier run on `333d4e3` caught the boot-order wipe fixed in #210); the lane's Runs-table selectors are scoped to the Runs section since the overview also renders regression-case and comparison tables as `.runs-table`. Known lane issue: driver processes can linger after exit (#148); stale processes on the controller machine caused the only "flaky" toolchain runs seen so far.

Round 7 additionally cleared several items from this list: `RUNTIME_PROVIDER=local-process` (the whole round ran on it), the browser flow with `APP_AUTH_TOKEN` set, Create-Agent-from-template through the form, sandbox denials as real product evidence, and the comparison UI's no-regression branch with live EvalRuns.

## 4. Not yet tested (remaining after round 9)

- Template-hash mismatch 409 and `force` through the API (needs a copy of a template edited after the case was recorded); the dashboard cannot send `force` yet (#215).
- `task_completion` (llm_judge) and `post_check` evaluators; `setsTaskOutcome` writing `taskOutcome`.
- The ≤ 800 px span-drawer overlay branch (round 6 measured 1920/1366/1024).
- The `REGRESSION · n assertions regressed` branch of the comparison banner (both round-5 EvalRuns passed 4/4) and the Jump-to-failing-span flow on a failed Run (E2E [6] covers it).
- `GLASSBOX_STORE=postgres` through the UI (`docker compose --profile postgres up`).

- Degraded trace store mid-Run (`telemetry.degraded`, `degraded` chip).
- Retention/eviction with a small `GLASSBOX_MAX_DISK_MB`; the `evicted` chip.
- Output cap (`CODEX_MAX_OUTPUT_BYTES`) → `limit.exceeded`; the real 600 s timeout.
- UI-driven flows: workspace switch from Settings, delete an Agent that has Runs, the Playground chat error states.
- Docker Compose profile (`docs/DEPLOYMENT.md`) up/down.
- Large traces (event cap, `trace.truncated`) and the tree's default expansion above 40 spans.
- Sandbox denial **on the container runtime** (round 7 demonstrated it on Windows local-process only; the judged Docker path still runs `danger-full-access` — see #92).
- The `REGRESSION` branch of the comparison banner and the new #234 template-mismatch banner (needs a template edited between two EvalRuns).
- The enriched run logs (#232) once merged: line content, warn level, denial coalescing in the panel.

## 5. Test data left on the local instance

Agents "UAT Baseline", "Demo", "Frontend Builder" (from rounds 1–3) and "UAT4 Template" (round 4, template-backed; its Run is a working example of the template flow); two Regression Cases created from that Run (one auto-named by the prefill route, one renamed). Round 7 ran against a fresh dev-state root and left Agent "UAT Round 7 Agent" with 3 Runs, one Regression Case and two 4/4-passed EvalRuns — a ready-made comparison demo dataset. Safe to delete.
