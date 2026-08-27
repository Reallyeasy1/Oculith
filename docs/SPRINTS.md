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

Status legend: done = every issue closed; in review = PRs open for every remaining issue; in progress = issues open without PRs. See `docs/PROJECT_BRIEF.md` for the live status board and the 27 August UAT round 3 findings that added the S2 evidence issues.

Lanes: A = runtime/starting state · B = trace/audit · C = evaluation · D = frontend · E = verification/submission.
