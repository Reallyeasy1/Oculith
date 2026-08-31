# GlassBox — pitch and three-minute demo script

_One product narrative for the TechJam Track 1 submission ("Agent Launchpad: Design and Build Lightweight Agent Middleware", Glass Box track). The presenter reads §2 during the demo recording (#95); §1 frames how judges should read the code; §3 is the Q&A pocket card. Runbook and fixtures: `docs/DEMO.md` (#92). Sources: `docs/PRD.md`, `docs/PROBLEM_STATEMENT.md`, `docs/UAT_COVERAGE.md`, `docs/OBSERVABILITY_ROADMAP.md`._

---

## 1. The pitch

### The arc

**Agents execute opaque chains of actions.** A Run on the starter kit ends in a final message or a one-line error. We hit the cost ourselves: a ten-minute timeout that looked like a model problem was actually every shell command paying a 40-second host-profile tax. The evidence existed — nothing in the product surfaced it.

**GlassBox instruments the real runtime.** Not a mock, not a wrapper UI: adapters at the real seams — Fastify → AgentService → AgentRunner → container/process → Codex → workspace — normalise everything into one versioned `ObservationEvent` contract, through a single redaction boundary, into an append-only local trace per Run. Thirty event types across nine categories today.

**The trace explains what happened.** One correlated tree from the HTTP request to the terminal result: per-call model activity, tool identities with durations and exit codes, token usage, sandbox denials as first-class evidence, and first-failure focus that puts the operator on the failing span in at most two interactions.

**Audit explains important decisions.** Every consequential event projects to an actor / action / resource / outcome row — human, agent, runner, or sandbox — each row linked to the source event. Not just *what ran*, but *who was allowed to do what*.

**Successful evidence becomes a regression check.** A good Run saves as a Regression Case: bounded task, workspace-template reference (content-hashed), and deterministic assertions pre-filled from the Run's own evidence. An EvalRun replays the case through the same real execution path in a fresh template copy and a fresh thread.

**An Agent change produces a detectable regression.** Change only the candidate's instructions so it loses the required billing fact; the fresh-workspace `post_check` fails, and the comparison classifies PASS→FAIL as `REGRESSION` — deterministically, with both traces linked as proof. Observability closes into verification.

### Track 1 alignment

The Glass Box track asks for correlated Run and step events in a timeline or tree; status, duration, errors, and available model usage; redacted secrets; one successful task and the failing step of one failed task identified. The demo shows each of these live, then goes further: audit rows, denial evidence, and the regression loop. Against the judging rubric — 40% end-to-end middleware behavior, 25% design and integration, 20% verification and robustness, 15% demo and reproducibility — the middleware runs in the backend path (not the UI), the baseline platform is preserved, `npm run check` plus the browser/Docker E2E lane (real runtime, real model where required, privacy sweep, performance bounds) cover the core events and policy decisions, and the judged path stays one documented command.

### What is real vs deferred

**Real, running, tested:**
- Instrumentation of the real seams; every Run — including cancelled, timed-out, and restart-cut Runs — yields one trace.
- Redaction before persistence: allowlist → key denylist → bounded pattern scan → truncation; on redactor error it fails closed to metadata only. Verified by an automated sweep of seeded fake keys across files, API, export, logs, and the rendered DOM.
- Runs list and trace detail with first-failure focus, span drawer, audit view, evidence chips, deep links, keyboard navigation.
- Per-Run metrics (`modelCallsObserved` per observed reasoning/message item, tool calls/failures, denials, tokens), the bounded metrics query API, reliability aggregate/compare endpoints, and dashboard cards for telemetry and each LLM-judge evaluator — built and tested.
- Regression Cases, isolated EvalRuns through AgentService, deterministic evaluators (`terminal_status`, `expected_tool`, `max_tool_calls`, `max_duration_ms`, `post_check`), comparison with `REGRESSION` classification, and the versioned `task_completion@1` LLM judge for historical quality — kept strictly outside the diagnosis path.
- Authenticated SSE nudges with polling fallback, plus the optional PostgreSQL trace/summary/evaluation stores behind the same interfaces; NDJSON + JSON remain the judged default.
- The gated deterministic failure fixture (`GLASSBOX_DEMO_FAILURE=timeout`) that traverses the same real Run path.
- Performance inside declared bounds: append p95 measured at 3.8 ms (bound 20 ms), 500-event query at 36.6 ms (bound 500 ms).

**Deferred (deliberately):** OTLP export (mapping library exists, unwired), evaluation-jobs progress UI, cost in the metric catalogue (per-Run estimate exists, display-only), and alerting (explicit non-goal). `workspace.changed` takes the platform's before/after disk snapshot as ground truth; the stream-side file-change report is a fallback observed only when the model uses apply_patch — neither path invents diffs.

**Prohibited, not deferred:** raw prompts, completions and chain-of-thought are never stored; under an explicit opt-in tier (`reasoning_summary`, #259), reasoning appears only as 240-char redacted summaries — and judges can still be handed the export file. `full/raw` is forbidden by the PRD, not merely unimplemented.

### One slide of architecture (in words)

Left to right: the **browser** (Runs view and trace detail — evidence only, no control) calls the **Fastify control plane**, where a trace context factory stamps every request with `traceId`, actor, and capture policy. **AgentService** owns Run state; an **AgentRunner** (local process or disposable container) executes **Codex CLI** against the **Ark model API**. Each seam emits `ObservationEvent`s into one **redaction boundary** — the only gate to persistence — then into an **append-only NDJSON trace store** with a rebuildable index. A **pure query layer** (`buildTrace`) derives spans, rollups, diagnosis, audit rows, and metrics from stored facts; the **Verify/Evaluate plane** (cases, EvalRuns, evaluators, comparison) consumes that same contract and never creates a second source of runtime truth. The trust boundary sits at redaction: nothing crosses into storage, API, export, or UI unredacted. (Diagram itself: #93/#206.)

---

## 2. The 3:00 demo script

_Nine steps matching the #92 runbook (`docs/DEMO.md`). **Say** lines are the spoken script — 410 words, word count at the bottom. Read at a normal presenting pace; each step's budget is generous enough to click while talking. Fallbacks per step are in the runbook._

### Step 1 — Orient (0:00–0:20)

**Click:** open `localhost:3000`, unlock with the token, select the **Demo** Agent.

**Say:** Agents execute opaque chains of actions. When a Run fails, the evidence usually exists — nothing surfaces it. GlassBox instruments the real runtime, so every Run becomes one correlated, privacy-safe trace. This is our Demo Agent; everything on this screen is stored evidence from real Runs.

### Step 2 — One live Run (0:20–0:45)

**Click:** Playground → send the Repo Doctor task ("fix the failing test") against the `node-lib-with-failing-test` template workspace.

**Say:** I'll start one live Run: fix the failing test in this repository. The request travels the real path — the control plane, the service, the runner, a disposable container, Codex — and GlassBox listens at the seams. While it works, everything you see next is stored evidence from Runs exactly like it.

### Step 3 — The trace (0:45–1:10)

**Click:** Runs table → open a finished Run's trace.
**PAUSE on the Metrics line: "22 model calls · 20 denied".**

**Say:** Here is a finished Run's trace: one tree from the HTTP request to the terminal result. Pause on this metrics line — twenty-two model calls, twenty denied commands. Codex reports a single turn, but we count each observed reasoning and message item, so a long Run is never one opaque bar.

### Step 4 — The denial (1:10–1:30)

**Click:** the first-denial focus card → the `policy.denied` span → the **Audit** view.

**Say:** Those denials are not log noise. Each one is first-class evidence: the sandbox declined this program, and the audit view names the actor — human, agent, runner, or sandbox. Audit answers what a log cannot: not just what ran, but who was allowed to do what.

### Step 5 — The failure (1:30–1:50)

**Click:** filter **Needs attention** → open the timed-out Run → **Jump to failing span**.

**Say:** Now a Run that failed. The banner names the first actionable failure, and one click lands on it: a three-second timeout in the runner layer. That diagnosis is a pure function over stored facts — no model ever guesses at what went wrong.

### Step 6 — Privacy and export (1:50–2:10)

**Click:** the **Evidence badges** in the trace header — **PAUSE** — then **Export** and open the downloaded file.

**Say:** Notice the evidence badges: model observed, tool observed. When the runtime can't show us a layer, we say so instead of inventing spans. And this is the export — we can hand judges the raw export file, because redaction runs before persistence and fails closed. No unredacted copy exists.

### Step 7 — Save the evidence (2:10–2:25)

**Click:** on the good Run: **Save as Regression Case** → show the pre-filled assertions → save.

**Say:** A good Run is worth keeping. One click saves it as a Regression Case: the task, the workspace template, and assertions pre-filled from the Run's own evidence — the tool it used, the check that passed.

### Step 8 — The regression (2:25–2:50)

**Click:** switch to the candidate Agent (instructions edited to skip tests) → **Run against** the case → open the comparison.
**PAUSE on the REGRESSION banner.**

**Say:** Now I change one thing: the candidate's instructions tell it to skip running tests. Rerun the case — a fresh copy of the same template, a fresh thread, through the same real path. The comparison classifies pass-to-fail deterministically: REGRESSION. An Agent change just produced a detectable regression, with both traces linked as proof.

### Step 9 — Close (2:50–3:00)

**Click:** back to the Agent overview.

**Say:** That is the loop: instrument the real runtime, explain every Run, audit the decisions, turn good evidence into regression checks, and catch the change that breaks them. Glass box, not black box. Thank you.

---

## 3. Q&A prep — ten likely judge questions

1. **Why is there no LLM judge in the diagnosis path?** Diagnosis is a pure function over stored facts — same events, same answer, reproducible in a demo and in a dispute; the LLM judge exists but lives in the separate Evaluate plane, labelled as judgement, never as fact.
2. **Why templates instead of exact replay?** A rerun is new execution from a versioned starting state (template + content hash) — replaying a stochastic agent byte-for-byte proves nothing, while a fresh run against the same start state tests the contract that actually matters.
3. **What does redaction cover, and what doesn't it?** It is exact on structured attributes (key denylist) and best-effort on free text (bounded pattern scan for bearer/`sk-`/`ark-`/AK-SK/private-key shapes); a novel secret format in a command string could slip past — which is exactly why the default policy stores metadata only.
4. **Why only one runtime?** Depth over breadth in six days: one runtime instrumented honestly end to end, behind a provider-neutral versioned event contract and an `AgentRunner` seam, so a second runtime is a new adapter, not a rewrite.
5. **Why no chain-of-thought capture?** Because that is the product promise — traces you can hand to anyone: raw prompts, completions and chain-of-thought are never stored. We capture the reasoning stream's *shape* at every policy (per-item model-call counts and reasoning-token usage); under an explicit opt-in tier (`reasoning_summary`), reasoning appears only as 240-char redacted summaries — and judges can still be handed the export file.
6. **Codex emits one turn — how do you count 22 model calls?** We count the observed reasoning and message items in Codex's own event stream (#207/#230), so `modelCallsObserved` is a count of things that actually happened, verified against a 321k-token production Run.
7. **What happens when the trace store fails mid-Run?** The emitter is non-blocking: the Run completes normally and the trace shows an explicit `telemetry.degraded` gap — observability failure is itself observable, and never costs the user their result.
8. **How is the cost figure computed?** Display-only: operator-configured prices per million tokens multiplied by observed usage — no configured price, no number shown, and it never feeds any decision.
9. **Why polling instead of SSE?** A locked PRD decision: a 1–2 s poll is indistinguishable in the demo and cuts a failure class from a single-process server; SSE is queued behind the P0 evidence work.
10. **What does the "recovered after N failures" chip mean?** A derived diagnosis: the Run had N failed tool calls but a later attempt succeeded and the Run completed — visible recovery, distinguished from a clean Run and from a real failure.

---

## 4. Script word count

Spoken script (the nine **Say** blocks): **410 words** — under the ~450-word / 3:00 budget, reading at ~150 words per minute with breathing room for the four evidence pauses. Timed per step above; total 3:00.
