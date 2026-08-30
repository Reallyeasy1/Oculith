# GlassBox demo runbook (#92)

The 9-step story, scripted by `scripts/demo/run-demo.sh [step]` (idempotent — re-runnable
from any step; it reuses whatever already exists and never prints secrets). Target: under
3:00 from step 1 to the REGRESSION banner. Run everything from Git Bash.

> **Rehearsal status** (logs on #92): the full 9-step story has been driven end to end on
> the dev instance (28 Aug — REGRESSION shown, steps 1–6 in ~10 s, 7–9 in ~110 s), and the
> judged Docker path has run steps 1–7 green from a clean root (29 Aug — steps 1–4 in 92 s,
> `post_check` executed for real). That rehearsal is what proved instruction-rigging alone
> could not regress step 9 and led to the `fee-ledger` knowledge gate (#298), which merged
> after it. **AC met:** the two timed judged-path (`npm run poc`) rehearsals are done — two
> consecutive clean-root cycles on `fee-ledger` in the Docker container runtime finished in
> **171 s** and **168 s**, both under the 3:00 budget (logged on #92).

## Pre-flight checklist (before the audience arrives)

1. **Clean state:** remove `.local/` (or point `LOCAL_POC_DATA_ROOT` at a fresh dir).
2. **`.env`:** `APP_AUTH_TOKEN` set (24+ chars, never spoken, never on screen),
   `GLASSBOX_DEMO_FAILURE=off`, `GLASSBOX_CAPTURE_POLICY=safe_summary` (the demo decision in
   `docs/OBSERVABILITY_ROADMAP.md` — it makes the Outcome line visible), real `ARK_API_KEY`
   + `ARK_MODEL`, and `CODEX_TIMEOUT_MS=120000` — the 3:00 budget needs the candidate bounded:
   against the brute-force-resistant gate (#315) a candidate may grind until cut, and its
   budget-exhausted Run *is* the regression evidence (step 9 accepts it as such).
3. **Start the judged Docker path.** On Windows (per CLAUDE.md — npm hands scripts to
   `cmd.exe` and Git Bash mangles mount paths):

   ```bash
   set -a; . ./.env; set +a
   MSYS_NO_PATHCONV=1 LOCAL_POC_DATA_ROOT="C:/<abs>/Oculith/.local" bash scripts/start-local-poc.sh
   ```

   On Linux/macOS: `npm run poc`. Baseline acceptance completes in ~70 s in the container.
4. **Pre-seed the failure beat** so the live demo never restarts a server (the gate is
   env-only): stop the server, set `GLASSBOX_DEMO_FAILURE=timeout`, start it, run
   `bash scripts/demo/run-demo.sh 5`, then set the gate back to `off` and restart. Step 5
   will find and reuse this recorded timeout Run during the demo.
5. `bash scripts/demo/run-demo.sh 1` must print `Pre-flight OK`.
6. Open the browser at the Launchpad, paste the token, keep the tab on the Runs list.

**The deterministic-failure choice (honest, per the issue):** the failure beat is the gated
fixture `GLASSBOX_DEMO_FAILURE=timeout` — it cuts the real runner after 3 s through the
normal Run path, every time. "Agent reported failure" was rejected because it depends on
model compliance. The gate needs a server restart on/off, which is why it is pre-seeded.

**The denial choice (honest, per the issue):** the judged Docker path falls back to
`CODEX_SANDBOX_MODE=danger-full-access` (Docker Desktop's kernel has no Landlock), so a
live denial is **not deterministic** there. UAT round 7 produced real denial-rich traces on
Windows `local-process` (read-only sandbox); one redacted `metadata_only` export — 25
`policy.denied` events, zero secrets — is committed at
`docs/assets/demo/denial-trace-export.json`, and step 6 shows the denial from that recorded
export and says so out loud.

**The knowledge gate (#298):** the demo template is `fee-ledger` — a fee-calculation library
whose tests assert SHA-256 checksums of the correct fee lines, so the expected numbers are
not recoverable from any workspace file, test name, or failing-test output. Two plans need a
business fact that lives only in the baseline instructions; the candidate configuration is
the same persona with that one line removed, so its best fix fails `post_check` every time —
the step-9 REGRESSION depends on knowledge, not on model mood or disobedience.

## The 9 steps

Run `bash scripts/demo/run-demo.sh` once at 0:00; it walks 1→9 and prints every URL to
open. Fallback for any live step that misbehaves: the pre-seeded Run/EvalRun ids from the
rehearsal (the script reuses them automatically on re-run) and the screenshots under
`docs/assets/demo/` (to be captured during the rehearsals, tracked on #92).

| # | Step | Run / click | Say (one line) | Expected screen | Fallback |
|---|------|-------------|----------------|-----------------|----------|
| 1 | Pre-flight | `run-demo.sh` starts; terminal shows `Pre-flight OK` | "Everything you'll see is one script against the public API — no hidden state." | Terminal: runtime, sandbox, model configured | If any check fails the script names the exact `.env` fix; fix and re-run `run-demo.sh 1` |
| 2 | Seed | (script) creates **Demo Agent** from `fee-ledger` | "Repo Doctor: a fee-calculation library whose test suite is red — and the fix needs a business fact the agent's instructions carry." | Sidebar shows Demo Agent | Agent already exists → script says so and continues |
| 3 | Baseline Run | (script) sends the fix-the-test task; ~70 s | "The agent applies the billing context from its configuration, fixes src/fees.js, and proves it with npm test." | Runs list: row flips queued → running → **ok** | A failed Run here means bad credentials — the script says exactly that; re-run `run-demo.sh 3`. Fallback: the rehearsal's ok Run is already in the list |
| 4 | Open trace | Click the printed `/?run=<id>` URL (or the ok row) | "One correlated, privacy-safe trace: every model turn and tool call, no prompt text stored." | Trace detail: span tree, metrics, Outcome line | Any pre-existing ok Run's trace tells the same story |
| 5 | Failure beat | (script) shows the pre-seeded timeout Run; click its URL | "Failures are first-class: deterministic fixture, same Run path — first-failure focus lands on `codex exec`." | Trace banner: **timeout**, Jump to failing span | Pre-seeded in pre-flight #4; if missing, the script prints the gate instructions — skip to 6 and show it after |
| 6 | Denial beat | (script) prints the recorded export summary; open `docs/assets/demo/denial-trace-export.json` | "Sandbox denials are evidence too — this is a real recorded trace from our Windows sandbox round, because the judged Docker box can't do Landlock; we say that honestly." | Terminal: `25 denials`, sample `sandbox_declined` command | The export file is committed — it cannot fail; screenshots as backup |
| 7 | Save the case | (script) prefill API saves a regression case from the baseline Run, then runs the baseline EvalRun | "The good Run becomes a regression case — including a post_check that re-runs the checksum suite in a fresh workspace, then proven green." | All runs → Regression cases row; EvalRun **N/N passed** | Case/EvalRun already exist → reused; UI path: trace → *Save as regression case* |
| 8 | Candidate config | (script) PATCHes the Agent's instructions: *the billing context line is removed* | "Someone 'tidies up' the instructions — one deleted line, looks harmless." | (terminal only; config hash changes) | PATCH is idempotent; re-run `run-demo.sh 8` |
| 9 | Candidate + compare | (script) runs the candidate EvalRun, fetches the comparison; open **All runs → Compare evaluations**, pick baseline vs candidate, click Compare | "GlassBox catches it: without that knowledge the candidate's best fix fails the checksum suite — post_check regresses deterministically, with evidence links to both traces." | Red **REGRESSION** banner, regressed rows highlighted | A no-regression here means a stale pre-gate EvalRun was reused — the script already re-runs a fresh candidate; the rehearsal's recorded comparison is the last resort |

Total budget: step 3 ≈ 70 s live; every other step is seconds. Steps 5 and 6 are recorded
evidence by design — the demo never depends on the model being in a good mood.

## Optional: showing redaction live

The default story never trips the redactor — nothing secret-shaped crosses the pipeline, so
the baseline trace shows `redactedEvents: 0`. To show the middleware's signature proof live,
opt in before the run:

```bash
DEMO_REDACTION_BEAT=1 bash scripts/demo/run-demo.sh
```

Step 3 then seeds `.notes/env-backup.txt` into the demo workspace — one **provably fake**
canary, an `ARK_API_KEY` assignment whose value is `ark-` plus the all-zeros/`dead-beef`
UUID (shaped to match the `ark_key` rule but impossible as a real key) — and appends one sentence
to the baseline prompt asking the agent to read that file, so the content crosses a tool
summary. The audience sees the **redacted** chip on the trace, `[REDACTED:env_assignment]` in the
drawer summary (the assignment rule swallows the inner key marker — that label is what actually
renders), and `redactedEvents > 0`; the script deletes the file after a successful Run (a failed
Run leaves it for the retry to overwrite — it is a fake value either way). The beat needs a fresh
baseline: resuming over an already-recorded ok Run skips the seed. Say the
honest line out loud: *"that's a seeded fake credential — the redactor caught it before
anything reached disk."* It adds ~10–20 s to step 3, and with the flag unset the script's
behavior is unchanged (the #92 timings stand) — skip the beat when tight on time.

## Resuming mid-demo

`run-demo.sh N` resumes at step N: it re-derives everything (agent, baseline Run,
case, EvalRuns) from the API, so a dropped terminal or a restarted server loses nothing.
Step 2 also resets the Agent's instructions to the baseline, so a full re-run from any
state is safe.
