# Tutorial: from first login to a detected regression

_A hands-on session, ~15 minutes plus model time. You'll run an agent on a broken repo, read the
evidence it leaves, turn its success into a regression check, and watch the platform catch a bad
configuration. Concepts are in the [User Guide](USER_GUIDE.md); setup is in the [README](../README.md)._

**Before you start:** the server is running (`npm run dev` or `npm run poc`), `.env` has working
Ark credentials, and — recommended for this tutorial — `GLASSBOX_CAPTURE_POLICY=safe_summary` so you
see text summaries, not just counts.

## Step 1 — Sign in (30s)

Open the app and paste the access token (the `APP_AUTH_TOKEN` the server was started with; anything
works if it's unset). You land on an empty Launchpad.

## Step 2 — Create an agent from a broken repo (1 min)

**Create Agent** →
- Name: `Tutorial Doctor`
- Instructions: `You fix Node libraries. Always run npm test to verify your work before replying.`
- **Start from**: `node-lib-with-failing-test` — a tiny library whose test suite fails on purpose.
- (Optional, recommended) Settings → **Verify command**: `npm test` — the platform will now check
  every completed Run itself.

## Step 3 — Give it the job (2–4 min model time)

In the Playground:

> The test suite is failing. Find the bug, fix it so npm test passes, and prove it.

Watch the **Live now** strip while it works. Send a second message immediately if you like — it
queues ("queued, 1 ahead") instead of erroring, and runs when the first finishes.

## Step 4 — Read the evidence (3 min)

When the reply lands, click its **trace** link (or the run row below).

Find these, top to bottom:
1. **Summary** — duration, tokens (note `cached`), **model calls** (real per-call count, not 1),
   and the **Evidence** badges: `model observed · tool observed`, files changed.
2. **Span tree** — every command the agent ran, with bounded identities, durations, exit codes.
   Toggle **Errors only**: any red rows are failed commands the agent recovered from.
3. **Logs** — the Run as a story: spawn, first output latency, each notable event, the completion
   summary. This is what you'd read first at 3am.
4. **Audit** — who did what: your message (human), the agent's commands (agent), the runtime's
   lifecycle (runner).
5. **Export JSON** — download it and open it: everything you just saw, redacted before it ever
   touched disk. There is no secret in this file. That's the product's core promise.

If the run shows a taskOutcome of `passed` in the runs list, that came from *your* verify command —
the platform ran `npm test` itself and measured success rather than trusting the agent's word.

## Step 5 — Freeze the success as a check (1 min)

In the trace header: **Save as regression case**. The dialog prefills assertions from this Run's own
evidence (terminal status, tool, budgets). Keep them, and note the case records the template's
content hash — if anyone edits the template later, evaluations will say so instead of silently
comparing apples to oranges. Save.

## Step 6 — Prove the baseline (2–4 min model time)

Overview (**All runs**) → **Regression cases** → **Run against Tutorial Doctor**.

This is an **EvalRun**: a *fresh* copy of the template, a fresh session, the case's exact prompt,
through the same real execution path. When it finishes the case row shows `N/N passed` with the
template-hash provenance. You now have a pinned baseline.

## Step 7 — Break the configuration (30s)

Agent → Settings → Instructions, replace with:

> You are extremely thorough. Read every file in the workspace twice and run every check you can
> think of, one command at a time, before and after any change.

The config hash changes — the platform now sees a *different configuration* of the same agent.

## Step 8 — Catch the regression (2–4 min model time)

**Run against Tutorial Doctor** again (this EvalRun is the *candidate*), then open
**Compare evaluations**, pick the first EvalRun as *Baseline* and the new one as *Candidate*, and
press **Compare**.

Any assertion that went PASS → FAIL is tinted and the banner reads **REGRESSION** — typically the
tool-call budget, since the "thorough" config burns far more commands than the baseline evidence
recorded. Every verdict links to the exact events that prove it. (If the candidate happened to stay
efficient, the banner honestly says *No regression* — the platform reports what happened, not what
the demo wants. Run the candidate again or make the instructions more extreme.)

## Step 9 — Clean up (optional)

Delete the case (Overview) and the agent (its workspace is archived, not destroyed). Or keep them —
the pair is a ready-made demo dataset.

## Where to go next

- Wire your own repo: create an agent on a real workspace, set its verify command to your test
  runner, and let every Run grade itself.
- Add a `post_check` assertion to a case (command must be on `GLASSBOX_POSTCHECK_ALLOWLIST`) — the
  strongest signal: the platform re-runs your check inside the evaluation workspace.
- Raise the capture policy to `reasoning_summary` to see 240-char redacted reasoning summaries per
  model call.
- Read the [User Guide](USER_GUIDE.md) §4 for everything a trace can tell you.
