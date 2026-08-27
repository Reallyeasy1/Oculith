# GlassBox TechJam MVP sprint plan

Encoded 26 August 2026. GitHub milestone: **TechJam MVP**. Active work uses labels `sprint:S1` through `sprint:S8`; S0 records completed Observe work.

```text
S0 ▶ S1 ─┬─ S2 (evidence + demo-visible UI) ─────────────────┬─ S6 (verify) ─┬─ S7 (demo) ─ S8 (submission)
         └─ S3 (starting state) ─ S4 (case) ─ S5 (execute+compare) ┘
```

| Sprint | Scope unit | Issues | Entry gate | Exit gate | Status (27 Aug) |
|---|---|---|---|---|---|
| S0 | Observe (done) | #21–#34, #38, #39, #60, #69, #70, #76 | — | `main` and E2E lane green | done |
| S1 | Contracts & PRD amendment | #79, #97, #104; contract huddles on #82–#85 | S0 | Shapes pinned; #79 and PRD §16 merged | done |
| S2 | Evidence + demo-visible UI | #81→#82, #74, #72, #87, #90, #98–#102; UAT round 3: #129, #130, #131, #132, #133, #134, #135, #136, #137, #138, #143 | S1 shapes | Denial/audit/metrics real; first-load, refresh and layout fixed | in progress |
| S3 | Starting state | #64→#68, #80 | S1 | Named workspace, template check command, sandboxed post-check | in review (#106, #123) |
| S4 | Regression case | #83, #84, #88 | S3 shape | Case saved from trace with five prefilled assertions and UI | in review (#128); #88 open |
| S5 | Execute and compare | #105→#85, #86, #89 | S4 | Ordinary isolated EvalRun; comparison flags PASS→FAIL as REGRESSION | in review (#127, #142, #144); #89 open |
| S6 | Verify | #91; finish #90 | S2 + S5 | Regression story in `npm run check`; new surfaces in verification lane | not started |
| S7 | Demo | #92; stretch #67, #103 | S5 | Demo script reaches step 9 from clean state; two rehearsals ≤ 3:00 | not started |
| S8 | Submission | #93, #35, #94, #95 | S7 | README verified on a clean clone; video ≤ 3:00 | not started |

Critical path: **S1 → S3 (#64→#68) → S4 (#84) → S5 (#105→#85→#86→#89) → S7 → S8**.

Cut order: **#67 → #80 → #89 → #87**. Never cut **#79, #81, #84, #85, #86, or #92**.

## Next up (plan after UAT rounds 3–4, 27 August, main `0a1146e`)

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

Lanes: A = runtime/starting state · B = trace/audit · C = evaluation · D = frontend · E = verification/submission.
