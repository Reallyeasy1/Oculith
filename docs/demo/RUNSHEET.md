# Demo run sheet — action + script, beat by beat

The single page to have open while recording the features cut. Each beat: **DO** (the
exact action), **SAY** (verbatim from `SCRIPT.md`), **CUE** (freeze/caption for the
edit). Raw recording can run long; the waits are trimmed. Step mechanics and per-step
fallbacks: `docs/DEMO.md`.

Before rolling: clean browser window (fresh profile or F11 full-screen — no extra tabs,
extension buttons, or bookmarks), notifications off, 1080p, token pasted once, mic off
(voiceover recorded separately).

Every evidence beat (5, 6, 7) opens pre-existing stored runs on the seeded demo
instance, so nothing depends on the model being in a good mood except beat 2 — and its
fallback is any existing ok run. `DEMO_REDACTION_BEAT=1 bash scripts/demo/run-demo.sh`
seeds the redaction run; `bash scripts/seed-demo.sh fail` seeds the timeout run.

---

## Beat 1 — Cold open (0:00–0:15)

**DO.** Land on **All runs**: stat tiles + the runs table showing ok and failed rows
together. Cursor still, one slow gesture toward the status column.

**SAY.** "AI agents change code, call tools, and touch files, and their final answer
rarely tells you what actually happened. Ours died once and gave us one word: 'error'.
Oculith is my answer to that night: every run becomes evidence you can inspect and
reuse."

**CUE.** None.

---

## Beat 2 — A real run (0:15–0:40)

**DO.** Sidebar → the Frontend Builder agent → type the campaign-style task into the
composer → Enter. Cut to the runs list; watch queued → running. Keep rolling.

**SAY.** "This is Frontend Builder. I ask it, right in the Playground, to apply our
approved campaign style to the primary button. The design values live in the agent's
configuration, not the task. The run travels the real path: control plane, service,
Codex, the Ark model. We trim the wait, never the result."

**CUE.** Caption: "wait trimmed".

---

## Beat 3 — The trace (0:40–1:10)

**DO.** Open the ok run. Pause on the header (chips, usage, time split, config hash).
Scroll the tree once, slowly. Click a tool span; the drawer opens on its attributes,
exit code, and events. Esc.

**SAY.** "And here is what I built Oculith for. One correlated trace: every model turn,
every command, every exit code, the files changed, the token bill, the time split. Click
any span and the drawer shows its attributes and events. If a layer exposed nothing,
Oculith says 'no evidence' instead of inventing it."

**CUE.** **FREEZE 1** on the drawer's exit code.

---

## Beat 4 — The judges (1:10–1:30)

**DO.** Scroll to the **Evaluation** block on the same trace: PASS pills, the judge's
written reason, evidence links. Then one beat on the Evaluators table / **New
evaluator** modal.

**SAY.** "Every run is also judged. Deterministic evaluators check the facts, and LLM
judges score task completion, recovery quality, even politeness, each with a written
reason and evidence links back into the trace. And when I want a new standard, I define
a judge right in the UI."

**CUE.** None.

---

## Beat 5 — Redaction (1:30–1:50)

**DO.** Open the seeded redaction run. Freeze on the purple **REDACTED** chip, then
click the reading span; the drawer summary ends in `[REDACTED:env_assignment]`.

**SAY.** "A confession: I planted a fake API key in that workspace, on purpose. The
trace wears a redacted chip, and the drawer shows a marker where my assignment used to
be. It never touched disk. Raw capture isn't a mode we turned off; it's a mode we never
built."

**CUE.** **FREEZE 2** on the drawer marker.

---

## Beat 6 — The failure (1:50–2:10)

**DO.** Runs → **Needs attention** → open the seeded timeout run. Let the red banner
land. Click **Jump to failing span**. Optional 1 s: Audit toggle.

**SAY.** "Now my favorite run: a failure. The banner names the first actionable timeout:
codex exec, runner layer, cut at three seconds. One click and I'm standing on the
failing span. That used to be twenty minutes of grepping logs."

**CUE.** **FREEZE 3** on the TIMEOUT badge.

---

## Beat 7 — Evidence becomes reliability (2:10–2:35)

**DO.** Back on a template-backed ok run: click **Save as regression case** (or show an
already-saved case). Show the case row's Latest evaluation all passed. Then All runs →
**Charts**: reliability tiles, then the per-judge cards.

**SAY.** "A green run is too good to waste: one click saves it as a regression case,
assertions pre-filled from its own evidence, replayed all green in a fresh workspace.
And over time the overview turns runs into reliability: completion rates, latency, cost,
a chart per judge."

**CUE.** **FREEZE 4** on the all-passed case row.

---

## Beat 8 — Close (2:35–2:50)

**DO.** The architecture one-pager (`docs/assets/architecture.png` full-screen, or the
README on GitHub). Slow pan; end on the Oculith title.

**SAY.** "Under the hood, Oculith is a thin observation plane: instrument the real
seams, redact before storage, diagnose from facts, and turn proven runs into checks. No
more black boxes. Every run, in plain sight."

**CUE.** Hold the diagram to the end.

---

**If a step misbehaves:** keep rolling, redo the click calmly; the per-step fallbacks in
`docs/DEMO.md` apply.
