# Demo story: what the camera actually sees

Scene-by-scene storyboard for the 2:30 video, planned against the real UI (walked with
Playwright on the live seeded instance, 31 Aug; the backup screenshots of every scene land
in `docs/assets/demo/` during the recorded takes). Narration lines live in `SCRIPT.md`;
mechanics and fallbacks in `docs/DEMO.md`. Where the seeded instance and the clean judged
instance differ, the "on the poc box" notes say what the recording will actually show.

## Scene 1: the cold open (terminal + gate)

Two windows side by side. Left: Git Bash running `run-demo.sh`, large font, printing its
pre-flight lines and `Pre-flight OK`. Right: the browser on the access gate, a single
centered card with a masked token field over a dark page. The presenter pastes the token
(masked, safe on camera) and the shell appears: dark sidebar, GlassBox wireframe-box logo,
"Observability for Agent Runs" under it, a violet Create Agent button, and the agent list.

On the poc box: the sidebar has only the Demo agent, and the Runs list starts almost empty.
That emptiness is the point; everything the camera sees from here on is created live.

## Scene 2: the setup (one sentence, one send)

The script creates the Demo Agent from the `fee-ledger` template and sends the fix-the-test
task. The camera stays on the Runs list as the new row appears and flips queued, then
running, with the live ms-elapsed ticker counting. This wait is where the recording keeps
rolling and the cut trims to a captioned "about 70 s, trimmed".

## Scene 3: green run, purple chip (the redaction beat)

The row lands on a green ok badge. Click it. The trace header fills the viewport:

- Eyebrow: `TRACE · SCHEMA 1.0 · SAFE_SUMMARY` (the seeded box shows METADATA_ONLY; the
  demo records with safe_summary so the Outcome line is populated).
- The metadata grid: trace id, agent, workspace, runtime/model
  (`local-process · deepseek-v4-fla…` on dev, container on poc), duration, events and span
  counts, usage (`49k in · 44k cached · 714 out` style), the time split
  (`model 16.2 s · tools 4.5 s`), config hash.
- Evidence chips: `MODEL OBSERVED`, `TOOL OBSERVED`, `1 FILES CHANGED`, and, because the
  script seeded a fake credential with `DEMO_REDACTION_BEAT=1`, the purple `REDACTED` chip.

Freeze half a second on the purple chip. Then click the reading span; the right-hand drawer
slides in (span id, parent, source `AgentService OBSERVED`, changed paths, its events) and
the summary shows `[REDACTED:env_assignment]` where the planted assignment was. That marker
is the single most important frame in the video.

## Scene 4: the tree itself

Scroll once through the span tree. Every row wears a status badge, a category column
(control / runtime / model / tool), a timeline bar, and a duration: `run.created`,
`agent_service.run 23.7 s`, `codex exec`, `model.turn 20.7 s`, then the tool rows
(`shell:bash ls 51 ms`, `shell:bash node 575 ms`, `shell:bash npm` and a `file_change`).
On the trace of the baseline run everything is green; the Evaluation block above the tree
lists the deterministic evaluators with PASS pills and per-assertion evidence links.

## Scene 5: the failure that explains itself

Filter to Needs attention, open the pre-seeded timeout Run. This screen sells the product:

- A red banner: **"First actionable timeout: codex exec"**, sub-line
  `runtime · AgentRunner`, body "Run timeout in AgentRunner after 3.4 s. Codex timed out
  after 3000 ms.", and a big **Jump to failing span** button. Click it; the tree scrolls
  and focuses the `codex exec` row with its TIMEOUT badge.
- Honesty details worth the pixels: evidence chips read `MODEL: NO EVIDENCE` and
  `TOOL: NO EVIDENCE` (nothing invented), and the judge evaluators FAIL with reasons
  ("no final response").

Optional one-second aside on the same screen: the Audit button flips the tree into the
actor / action / resource / outcome table (`human · local-user`, `service · runner`,
outcomes ALLOWED / OK / TIMEOUT), if the cut has room. It is the first thing to trim.

## Scene 6: evidence becomes a check

Back on the baseline Run, **Save as regression case** (enabled, because the fee-ledger Run
is template-backed; the seeded box's non-template runs show it disabled with an explainer).
Cut to the All runs overview: the Regression cases card now holds the row, the same shape
as the seeded example ("fix-failing-test stays green · node-lib-with-failing-test ·
baseline hash · 4 assertions"), with Run and Delete actions. The script runs the baseline
EvalRun; the row's Latest evaluation cell reads all passed.

## Scene 7: one deleted line

Terminal only, three seconds: the script PATCHes the Agent's instructions, removing the
billing-context line. Caption the config hash change. No UI to show; the brevity is the
message.

## Scene 8: the catch

The candidate EvalRun runs (captioned trim), then Compare evaluations in the overview: pick
baseline and candidate in the two dropdowns, hit Compare. The comparison renders with the
red REGRESSION banner and the regressed assertion rows highlighted, both sides linking to
their traces. Freeze on the banner. This state only exists mid-demo-flow (the seeded box
shows "No regression · all compared assertions held" from its own history, gallery shot
17), which is exactly why the demo runs it live.

## Scene 9: close

One click back to the overview: stat tiles, the reliability strip with its "ALL-TIME"
label, the runs table. On the seeded box this screen also carries the per-judge chart cards
(Politeness Judge, Recovery Quality, Task Completion on a fixed 0-5 axis); the 2:30 cut
dropped that beat, and the Devpost gallery covers it instead.

## What got cut for 2:30, and why it is safe

- The recorded denial-export beat: a JSON file in a terminal is the weakest visual; the
  Track 1 brief's "failing step identified" requirement is fully carried by scene 5, and
  the honest denial story stays in the README and Devpost text.
- The charts / long-game pan: gallery images 04 and 13 already show it better than a
  five-second pan can.
- The audit table survives only as an optional one-second aside in scene 5.
