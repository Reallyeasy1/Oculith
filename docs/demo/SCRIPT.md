# Demo video script (2:30 cut)

Read the SAY lines over the footage at a normal presenting pace; about 360 spoken words,
which lands near 2:20 and leaves room for the three freeze-frames. Timestamps are targets
for the final cut, not the recording; the two long waits are trimmed and captioned. Click
cues match the scene numbers in `STORY.md`; recovery for any step is in `docs/DEMO.md`.
Cut from the bottom of scene 5 first if running long.

---

**0:00 - 0:15 | Cold open** (scene 1)

ON SCREEN: terminal prints `Pre-flight OK`; browser unlocks past the token gate into the
Oculith shell.

SAY: Three days into building with agents, ours died and the log gave us one word:
"error". One word. We lost a whole evening to guessing. Never again. That is
the itch Oculith scratches. Everything you're about to see is one script driving the same
API a judge gets. No mocks. No hidden state.

---

**0:15 - 0:35 | The setup** (scene 2)

ON SCREEN: Demo Agent appears from the `fee-ledger` template; the task is typed into the
Playground and sent; the run row flips queued, then running. Caption: "about 70 s,
trimmed".

SAY: This is Repo Doctor: a small fee library with a red test suite, and the one business
fact needed to fix it lives in the agent's instructions. Hold onto that; it becomes the whole story. The run travels the real path: control plane, service, a
disposable container, Codex itself. Nothing staged.

---

**0:35 - 1:00 | Green run, purple chip** (scene 3)

ON SCREEN: the row lands on ok; the trace header opens. Freeze on the purple REDACTED chip,
then the drawer showing `[REDACTED:env_assignment]`.

SAY: While it worked, a confession: I planted a fake API key in that workspace. On
purpose. Watch what became of it. The trace wears a redacted chip, and in the drawer
there's just a marker where the assignment used to be. It never touched disk.
Raw capture isn't a mode we turned off; it's a mode we never built.

---

**1:00 - 1:20 | The tree** (scene 4)

ON SCREEN: scroll the span tree: model turn, tool calls with durations and exit codes,
usage numbers, PASS pills in the Evaluation block.

SAY: And this is what I wished we had on day three. One tree from the HTTP request to the
result: every model turn, every command, every exit code, the token bill. If we didn't
observe it, it isn't on this screen. Nothing here guesses.

---

**1:20 - 1:40 | The failure** (scene 5)

ON SCREEN: Needs attention filter; the timeout Run opens on its red banner; click Jump to
failing span; freeze on the TIMEOUT badge.

SAY: Now my favorite run: a failure. The banner says it straight. First actionable
timeout, codex exec, runner layer, cut at three seconds. One click and I'm standing on
the failing span. That used to be twenty minutes of grepping logs.

---

**1:40 - 1:55 | Evidence becomes a check** (scene 6)

ON SCREEN: Save as regression case on the good Run; the case row appears; the baseline
EvalRun's Latest evaluation reads all passed.

SAY: That green run is too good to waste. One click turns it into a regression case, with
assertions pre-filled from its own evidence, including a post check that reruns the tests
in a fresh workspace. Replayed as a baseline: all green.

---

**1:55 - 2:05 | One deleted line** (scene 7)

ON SCREEN: terminal PATCHes the instructions. Caption: "one line removed; config hash
changed".

SAY: Then I do what a well-meaning teammate once did to us: tidy up the instructions. One
line gone. Looks completely harmless. It isn't.

---

**2:05 - 2:25 | The catch** (scene 8)

ON SCREEN: candidate EvalRun (captioned trim); Compare evaluations; freeze on the red
REGRESSION banner.

SAY: Same case, fresh workspace, same real path. Without that one fact, its best fix
fails the checksum suite. Every single time. REGRESSION, in red, with both traces linked
as receipts.

---

**2:25 - 2:30 | Close** (scene 9)

ON SCREEN: back to the overview: stat tiles, reliability strip, runs table.

SAY: That deleted line would have reached Friday's demo. Oculith caught it in about a
minute. No more black boxes. Every run, in plain sight.
