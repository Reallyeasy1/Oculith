# Demo video script — features cut (2:50 target)

The narration for the submission video: a feature showcase in eight beats. ~370 spoken
words, landing near 2:50 at a 125–130 wpm presenting pace with pauses on the four freeze
moments. Recording actions beat by beat: `RUNSHEET.md`. (`docs/DEMO.md` is the separate
scripted fee-ledger runbook; it seeds the stored runs beats 5–6 open.)

Cutting order if long: the last sentence of the trace beat first, then the audit aside in
the failure beat.

---

**0:00 - 0:15 | Cold open** (Runs overview, mixed ok and failed rows)

SAY: AI agents change code, call tools, and touch files, and their final answer rarely
tells you what actually happened. Ours died once and gave us one word: "error". Oculith
is my answer to that night: every run becomes evidence you can inspect and reuse.

---

**0:15 - 0:40 | A real run** (Playground: type the task, send; row flips queued →
running → ok; trim captioned)

SAY: This is Frontend Builder. I ask it, right in the Playground, to apply our approved
campaign style to the primary button. The design values live in the agent's
configuration, not the task. The run travels the real path: control plane, service,
Codex, the Ark model. We trim the wait, never the result.

---

**0:40 - 1:10 | The trace** (open the ok run; scroll the tree; click a tool span)

SAY: And here is what I built Oculith for. One correlated trace: every model turn, every
command, every exit code, the files changed, the token bill, the time split. Click any
span and the drawer shows its attributes and events. If a layer exposed nothing, Oculith
says "no evidence" instead of inventing it.

---

**1:10 - 1:30 | The judges** (Evaluation block: PASS pills, written reasons, evidence
links; the New evaluator modal)

SAY: Every run is also judged. Deterministic evaluators check the facts, and LLM judges
score task completion, recovery quality, even politeness, each with a written reason and
evidence links back into the trace. And when I want a new standard, I define a judge
right in the UI.

---

**1:30 - 1:50 | Redaction** (open the redaction run: freeze on the REDACTED chip, then
the drawer marker)

SAY: A confession: I planted a fake API key in that workspace, on purpose. The trace
wears a redacted chip, and the drawer shows a marker where my assignment used to be. It
never touched disk. Raw capture isn't a mode we turned off; it's a mode we never built.

---

**1:50 - 2:10 | The failure** (Needs attention → timeout run → red banner → Jump; 1 s
audit toggle optional)

SAY: Now my favorite run: a failure. The banner names the first actionable timeout:
codex exec, runner layer, cut at three seconds. One click and I'm standing on the
failing span. That used to be twenty minutes of grepping logs.

---

**2:10 - 2:35 | Evidence becomes reliability** (ok run → Save as regression case → case
row all passed → overview charts + per-judge cards)

SAY: A green run is too good to waste: one click saves it as a regression case,
assertions pre-filled from its own evidence, replayed all green in a fresh workspace.
And over time the overview turns runs into reliability: completion rates, latency, cost,
a chart per judge.

---

**2:35 - 2:50 | Close** (the architecture one-pager; end on the Oculith name)

SAY: Under the hood, Oculith is a thin observation plane: instrument the real seams,
redact before storage, diagnose from facts, and turn proven runs into checks. No more
black boxes. Every run, in plain sight.
