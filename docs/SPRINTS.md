# Oculith TechJam MVP sprint plan

Encoded 26 August 2026. GitHub milestone: **TechJam MVP**. Active work uses labels `sprint:S1` through `sprint:S8` and, from 27 August, `sprint:E1` through `sprint:E3` for the Evaluate plane (PRD v4 §17); S0 records completed Observe work.

```text
S0 ▶ S1 ─┬─ S2 (evidence + demo-visible UI) ─────────────────┬─ S6 (verify) ─┬─ S7 (demo) ─ S8 (submission)
         └─ S3 (starting state) ─ S4 (case) ─ S5 (execute+compare) ┤
                                                                   └─ E1 (summaries + evaluators) ─ E2 (jobs + judge + aggregates) ─ E3 (dashboard + compare) ─┘
```

E1–E3 run in parallel with S6–S8 on lane F; S7's demo script (PRD §13 v4) walks the E3 surfaces, while S6 still proves the deterministic AC-08 loop.

| Sprint | Scope unit | Issues | Entry gate | Exit gate | Status (27 Aug) |
|---|---|---|---|---|---|
| S0 | Observe (done) | #21–#34, #38, #39, #60, #69, #70, #76 | — | `main` and E2E lane green | done |
| S1 | Contracts & PRD amendment | #79, #97, #104; contract huddles on #82–#85 | S0 | Shapes pinned; #79 and PRD §16 merged | done |
| S2 | Evidence + demo-visible UI | #81→#82, #74, #72, #87, #90, #98–#102; UAT round 3: #129, #130, #131, #132, #133, #134, #135, #136, #137, #138, #143 | S1 shapes | Denial/audit/metrics real; first-load, refresh and layout fixed | in progress |
| S3 | Starting state | #64→#68, #80 | S1 | Named workspace, template check command, sandboxed post-check | in review (#106, #123) |
| S4 | Regression case | #83, #84, #88 | S3 shape | Case saved from trace with five prefilled assertions and UI | in review (#128); #88 open |
| S5 | Execute and compare | #105→#85, #86, #89 | S4 | Ordinary isolated EvalRun; comparison flags PASS→FAIL as REGRESSION | in review (#127, #142, #144); #89 open |
| E1 | Evaluate foundations | #167 (PRD v4) → #168, #169; #176 | S5 on main (#142, #144); PRD v4 merged before #168/#169 code lands | `/api/runs` served from summaries with `taskOutcome: unknown` and zero NDJSON reads; versioned evaluator definitions and redacted results persisted; template hash checked at rerun | in progress (#167, #168, #176) |
| E2 | Jobs, judge, aggregates | #170 → #171; #172 | E1 stores merged | A job over the ~20 local Runs is resumable after restart and never delays a live Run; `task_completion@1` returns cited results on the UAT fixtures with the fake judge; reliability and compare endpoints equal hand computation with provenance | not started |
| E3 | Dashboard and comparison | #173 → #174; P1 #191 (PR #197); P2 #175, #177 | E2 endpoints and stored results | AC-09 from the browser with stored results; lane step covers the panel and drill-back; comparison says "quality drift", never REGRESSION; `npm run poc` unchanged with Postgres optional | not started |
| S6 | Verify | #91; finish #90 | S2 + S5 | Regression story in `npm run check`; new surfaces in verification lane | not started |
| S7 | Demo | #92; stretch #67, #103 | S5 | Demo script reaches step 9 from clean state; two rehearsals ≤ 3:00 | not started |
| S8 | Submission | #93, #35, #94, #95 | S7 | README verified on a clean clone; video ≤ 3:00 | not started |

Critical path: **S1 → S3 (#64→#68) → S4 (#84) → S5 (#105→#85→#86→#89) → S7 → S8**.

Cut order: **#67 → #80 → #89 → #87**. Never cut **#79, #81, #84, #85, #86, or #92**.

Evaluate critical path: **#167 → #168 → #169 → #170 → #171 → #172 → #173 → #174** (E3 feeds S7's rehearsals). Evaluate cut order: **#177 → #175 → #176**; never cut #168, #190, #172, #173 (the P0 observability core; PRD §13 v4 walks it); #169–#171 and #174 are the P1 fast follow.

## Next up (28 August — observability first, main `189986c`)

Direction locked 28 August: **data → query → aggregation → visualization**. Observation events → Trace Store → *Metric Processor* (objective metrics = the Run summary rollup) and *Batch Evaluator* (semantic metrics = evaluation results) → *Metric Store* (read facade over both) → one bounded metric query → dashboard → Run/trace drill-down. Online observability (trace / audit / metrics) is the main priority; offline semantic evaluation is the fast follow.

| Track | Order | Issues | Why now |
|---|---|---|---|
| A — land the Verify chain | 1 | #151 (#88) → #152 (#89) → #178 (#167) → #189 (#168) → #179 (#176) | all reviewed; #152's deep-link blocker fixed; #179 needs a `main` merge after #151 |
| B — observability core (P0) | 2 | #168 → #190 (metric query + `MetricStore` facade) → #172 (reliability/compare as sugar) → #173 (dashboard, drill-back) | the rollup is the Metric Processor; the query contract is what makes the dashboard queryable, not just drawn |
| | 3 | #130 → #129 → #132 → #136 (P1) | evidence quality feeds the objective metrics (tool identity, model turns, outcome line — #132 raised to P0) |
| C — storage (P1, started) | 4 | #191 / PR #197 (Postgres phase C: summaries, then evaluation results) | opt-in `GLASSBOX_STORE=postgres`; judged path stays JSON/NDJSON; #175's trace/agents phases → P2 |
| D — semantic evaluation (P1, fast follow) | 5 | #169 → #170 → #171 → #174 → #192 (user-defined evaluators) | the Batch Evaluator branch; dashboard shows telemetry-only until these land |
| E — submission | 6 | #92, #35, #93, #94, #95 | unchanged |

Deferred: #193 safety evaluator (P2), #177 recovery quality (P2), #175 phases B/D (P2), #134, #103, #75, #37, #40, #65, #66, #96.

Label changes made with this plan: #169 #170 #171 #174 → P1; #175 → P2; #132 → P0; new #190 (P0, E2), #191 (P1, E3, in progress), #192 (P1, E3), #193 (P2, E3).

## Previous plan (plan after UAT rounds 3–4, 27 August, main `0a1146e`)

Ordered by what the three-minute demo (PRD §13) needs first. Tracks run in parallel across lanes; within a track the order is the dependency order.

| Track | Order | Issues | Why now |
|---|---|---|---|
| A — finish the Verify chain (critical path) | 1 | #142 (#85), #144 (#86) — unblock and land | EvalRun and comparison are the demo's steps 6–7; blockers are bounded (real-Run wait, restart close-out, batch test; per-assertion count) |
| | 2 | #151 (#88, with #158's single create path), #152 (#89) | the demo needs the UI, not the API — #88/#89 raised to P0 |
| | 3 | #91, #90 | AC-08 inside `npm run check`; lane covers audit, workspace changes, templates, cases |
| | 4 | #92 | template named as the PRD says, check command declared so `post_check` prefills, a product path to a denial |
| B — evidence quality | 5 | #130 → #129 → #132 → #156 → #136 | tool identity makes `expected_tool` meaningful (today every assertion says `bash`); model turns explain where time goes; outcome line closes "ok ≠ success" |
| C — surfacing fixes | 6 | #154, #157, #155, #138, #137; author-blocked #124 #125 #118 | small, batch by area; found in round 4 |
| D — verification reliability | 7 | #148 then #90 | the driver leak caused every flaky toolchain run on 27 Aug |
| E — submission | 8 | #35, #93, #94, #95 | after S7's two rehearsals |

Deferred past the demo: #134 baselines (P2, `sprint:S8` stretch), #103, #75, #37, #40, #65, #66, #96.

Label changes made with this plan: #88 and #89 → P0; #148 → `sprint:S6`; #134 → P2 `sprint:S8`; #155 → `sprint:S2`.

Status legend: done = every issue closed; in review = PRs open for every remaining issue; in progress = issues open without PRs. See `docs/PROJECT_BRIEF.md` for the live status board and the 27 August UAT round 3 findings that added the S2 evidence issues.

Lanes: A = runtime/starting state · B = trace/audit · C = evaluation · D = frontend · E = verification/submission · F = Evaluate plane (E1–E3).
