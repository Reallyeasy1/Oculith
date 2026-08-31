# Demo production plan (issue #95, detailed)

The complete plan for producing the submission video: environment, rehearsal, the recording
session itself, editing, QA, and upload. Companion files: `STORY.md` (what the camera
sees, scene by scene, grounded in a Playwright walk of the real UI) and `SCRIPT.md`
(the 2:30 narration). Step mechanics and per-step fallbacks: `docs/DEMO.md`.

## 1. Goal and hard constraints

One video, final cut at 2:30 (the #95 ceiling is 3:00; we come in under it), 1080p,
recorded against the judged configuration (`npm run poc`, Docker container runtime, clean
data root). It must show: a successful task end to end, a failed task with the failing step
identified, the correlated trace tree with durations/errors/usage, redaction proven on
screen, and the save-case → candidate → REGRESSION loop. No secret, token, or personal path
in any frame. Rubric weighting says where the seconds go: end-to-end behavior 40% (scenes
3-5 and 8), design/integration 25% (the "one script, real seams" framing), verification
20% (scenes 6-8), reproducibility 15% (the pre-flight open).

## 2. Schedule against the deadline (~Sep 1)

| When | What | Time |
|---|---|---|
| Tonight, slot 1 | Environment prep + pre-seed (section 3) | 20 min |
| Tonight, slot 2 | One full un-recorded rehearsal (section 4) | 10 min |
| Tonight, slot 3 | Two recorded takes back to back (section 5) | 20 min |
| Tomorrow morning | Edit to 2:30, captions, freeze-frames (section 6) | 60-90 min |
| Tomorrow morning | QA: privacy sweep + frame check (section 7) | 20 min |
| Tomorrow, before noon | Export, upload unlisted, link into submission + README (section 8) | 20 min |

Do not stack this against the submission hour. Everything after recording can happen while
the Devpost form is being filled.

## 3. Environment prep (exact commands, this Windows box)

Work from Git Bash in `Oculith/`. Docker Desktop running.

1. Fresh data root (do not touch `.local` if it holds anything you want; use a new dir):
   `export LOCAL_POC_DATA_ROOT="C:/<abs>/Oculith/.local-video"`
2. `.env` review (read it in an editor, not on the recorded screen):
   `APP_AUTH_TOKEN` set (24+ chars), `GLASSBOX_DEMO_FAILURE=off`,
   `GLASSBOX_CAPTURE_POLICY=safe_summary`, real `ARK_API_KEY` + `ARK_MODEL`,
   `CODEX_TIMEOUT_MS=120000`.
3. Start the judged path (the Windows invocation from CLAUDE.md):
   ```bash
   set -a; . ./.env; set +a
   MSYS_NO_PATHCONV=1 LOCAL_POC_DATA_ROOT="C:/<abs>/Oculith/.local-video" bash scripts/start-local-poc.sh
   ```
4. Pre-seed the timeout Run (the failure beat; the gate is env-only, so this is the one
   server restart, done before any camera): stop the server, set
   `GLASSBOX_DEMO_FAILURE=timeout`, start it, run `bash scripts/demo/run-demo.sh 5`, set
   the gate back to `off`, restart. The demo later reuses this recorded Run.
5. `bash scripts/demo/run-demo.sh 1` must print `Pre-flight OK`.
6. Screen prep: browser at 1920x1080, 100% zoom, bookmarks bar hidden, notifications off
   (Focus Assist on), terminal font 16pt+, only the two demo windows on the desktop. Paste
   the token once now so the session is unlocked muscle memory (the gate masks it anyway).

## 4. The rehearsal pass (un-recorded, mandatory)

Run the full story once: `DEMO_REDACTION_BEAT=1 bash scripts/demo/run-demo.sh` and click
along with `STORY.md`. This pass has three jobs: muscle memory for the clicks, a
timing sanity check (the two prior judged-path rehearsals logged 171 s and 168 s wall
clock), and, crucially, it leaves a complete set of good Runs/EvalRuns in the instance as
live fallbacks. If any step misbehaves here, fix it before recording; `run-demo.sh N`
resumes idempotently at step N.

## 5. Run of show (the recording session)

Record screen + mic together (OBS or any 1080p recorder; system audio off). Roll from
before the script starts; never stop the recording mid-take. Two full takes back to back;
take two is the committed backup (#95). The beats, keyed to `STORY.md` scenes and the
`SCRIPT.md` lines:

| Clock (raw) | Terminal | Browser | Freeze / caption |
|---|---|---|---|
| 0:00 | `DEMO_REDACTION_BEAT=1 bash scripts/demo/run-demo.sh` starts, `Pre-flight OK` visible | Token gate, unlock, land on Runs list | none |
| 0:20 | Script seeds Demo Agent, sends the task | Watch the row flip queued → running | caption later: "about 70 s, trimmed" |
| ~1:40 | Run completes | Open the ok Run; freeze the purple REDACTED chip; open the reading span's drawer on `[REDACTED:env_assignment]` | FREEZE 1 |
| ~2:10 | | Scroll the span tree once, slowly | none |
| ~2:30 | | Needs attention → timeout Run → red banner → Jump to failing span | FREEZE 2 on the TIMEOUT badge |
| ~2:50 | | (optional 1 s: Audit toggle) | first thing to trim |
| ~3:00 | Script saves the case, runs baseline EvalRun | Overview: case row + "all passed" | none |
| ~3:20 | Script PATCHes instructions | stay on terminal | caption: "one line removed; config hash changed" |
| ~3:30 | Candidate EvalRun runs | Compare evaluations → pick baseline vs candidate → Compare | caption the trim; FREEZE 3 on REGRESSION |
| ~4:30 | | Back to the overview | none |

Presenter notes: talk through the waits (the narration is written to cover them), keep the
mouse still except for deliberate moves, and if a click misses, just redo it calmly; the
edit removes stumbles, and take two exists.

## 6. Editing plan (raw ≈ 4:30 → cut 2:30)

- Map the raw take onto the timestamps in `SCRIPT.md`. The only cuts are the two
  waits (baseline Run, candidate EvalRun); caption each trim honestly on screen.
- Captions: the two trim captions, the config-hash change, and trace ids where the story
  file calls for them. White text, bottom third, no animation.
- Hold each freeze-frame a beat longer than feels natural: the REDACTED marker, the
  timeout banner, the REGRESSION banner. Those are the product.
- No music, no motion graphics, no speed-ups. The video must never look faster than the
  product actually is; judges have the runbook with real timings.
- If the cut lands over 2:30: drop the audit aside, then tighten scene 4's scroll. Do not
  touch scenes 3, 5, or 8.

## 7. QA before upload

1. Privacy sweep of the recorded instance: run the round-13 canary harness
   (paste one runtime-built canary key as a prompt, assert every serve surface returns the
   `[REDACTED:...]` marker and never the key: the #388 test in `apps/server/src/app.test.ts`
   is the pattern), then purge the canary run from the store with the
   clean-canary pattern. Zero leaks expected; the suite is the proof.
2. Frame-by-frame check at the risky moments: the terminal during `.env`-adjacent steps,
   the token gate (masked field only), any file dialog. No `APP_AUTH_TOKEN` value, no
   `ARK_API_KEY`, no personal `C:\Users\...` paths in frame. The `run-demo.sh` output is
   designed never to print secrets, but verify, don't assume.
3. Watch the full cut once with sound at normal speed. If a spoken claim and the screen
   disagree anywhere, fix the cut, not the claim.

## 8. Export, upload, link

Export 1920x1080, H.264, confirm length ≤ 2:30. Upload to YouTube unlisted. Paste the URL
into the Devpost submission draft (video field) and the README's demo link; commit the README change
(one-issue-one-PR applies; it can ride the submission-day docs PR). Commit the backup
screenshots of every scene to `docs/assets/demo/`. Keep take two's raw file somewhere safe
until judging ends.

## 9. Contingencies

- **Model has a bad day on the baseline Run**: the rehearsal pass left a good Run in the
  instance; open that one and keep narrating (the script's lines work over either).
- **Step 9 shows no regression**: a stale pre-gate EvalRun got reused; the script already
  re-runs a fresh candidate. Last resort: the rehearsal's recorded comparison.
- **Timeout Run missing**: pre-flight step 4 was skipped; it cannot be seeded on camera
  (needs a restart), so record the take without scene 5 and splice it from take two.
- **Recording glitch**: take two is a full take, not a patch reel; prefer splicing whole
  scenes over frankensteining moments.
- **Total loss of the live flow**: `docs/DEMO.md` fallbacks name recorded Run ids and
  screenshots for every step; a narrated-screenshots video is the absolute floor and still
  satisfies the brief's evidence lines.

## 10. What the 2:30 cut dropped, and why it is safe

The recorded denial-export beat (weakest visual; scene 5 fully carries the failing-step
requirement, and the honest denial story stays in the README and Devpost text), the
reliability-charts pan (gallery images 04 and 13 show it better), and the audit table
except as an optional one-second aside. Rationale and the scene-by-scene detail live in
`STORY.md`.
