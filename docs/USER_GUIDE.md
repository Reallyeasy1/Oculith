# GlassBox User Guide

_How to operate the platform day to day: run agents, read their evidence, and turn good runs into
regression checks. For setup and reproduction see the [README](../README.md); for a guided first
session see the [Tutorial](TUTORIAL.md); for the demo script see [DEMO.md](DEMO.md)._

## 1. Signing in

Open the app (dev: `http://localhost:5173`, judged path: `http://localhost:3000`) and enter the
**access token** — the value of `APP_AUTH_TOKEN` the server was started with. If the operator left it
empty, auth is off and any value works. The token lives only in your browser's memory: a page reload
asks again.

## 2. Agents

An **Agent** is a persistent workspace folder plus a resumable Codex session and its configuration.

- **Create Agent** — name, description, instructions, and optionally:
  - **Workspace**: share an existing workspace by name, or leave blank for a managed one.
  - **Start from**: seed the workspace from a template (e.g. `node-lib-with-failing-test`).
    Templates are content-hashed; the hash later guards regression cases (§6).
  - **Verify command** (Settings): a command (e.g. `npm test`) the *platform itself* runs in the
    workspace after every completed Run. Its exit code becomes the Run's measured **task outcome**
    (`post_check`) — replacing the phrase-based "agent reported failure" heuristic with ground truth.
    The command is stored on the Agent but never appears in traces (only its sha256 enters the
    config snapshot).
- **Sessions**: multi-turn memory is the Codex thread. The **session health** badge next to
  *New session* shows `Session: N turns · X tokens in`; it turns amber past 1M cumulative input
  tokens — a hint that context is deep and **New session** may improve quality. Advisory only.
- **States**: `ready → busy` while a Run executes; `stopped` via Stop; `error` after a failed Run
  (send another message or Stop/Start to recover). Delete archives the workspace rather than
  destroying it.

## 3. Running work

Type into the Playground and press Enter. Runs are asynchronous: the Run is queued, the UI polls.

- **Message queue**: a busy Agent *accepts* your message and queues it (up to 10; the composer shows
  "queued, N ahead" and each queued row has a Cancel). Queued messages survive restarts; each
  dequeued Run gets its own trace with a `queuedMs` attribute showing its wait.
- **Re-run prompt**: on any assistant reply's trace, or on a failure bubble, *Re-run prompt* sends
  the identical prompt again as a fresh Run (lineage recorded as `rerunOf` on the new trace).
- **Live**: while a Run executes, the **Live now** strip shows elapsed time and last-event age, and
  the run row streams event/tool/denial counts.
- **Failures**: the failure bubble shows the redacted error with a **View trace** link. Provider
  problems carry a derived hint chip (e.g. 401 → "check ARK_API_KEY / model access") — fixed rules
  over stored text, never a guess.

## 4. Reading a trace

Every Run is one correlated, privacy-safe trace. Click any run row (or a chat *trace* link).

- **Runs table**: filter chips (*Needs attention* is the default — failures, denials, degraded, or
  agent-reported failure; a run that merely *recovered* from tool errors is informational, not
  flagged). Columns include duration, first failing step, config hash, usage and cost (when pricing
  is configured), and tool/denial counts.
- **Summary panel**: duration, events/spans, token usage (input · cached · output · reasoning),
  metrics (tool calls, failures, **model calls**, denials), time split, config hash, and
  **Evidence** — per-layer honesty badges (`model observed`, `tool unavailable`, files changed).
  When the runtime exposes nothing for a layer, the platform says so instead of inventing spans.
- **Failure focus**: the first actionable error/denial with a deterministic diagnosis, a hint chip
  where a fixed rule applies, and **Jump to failing span**.
- **Span tree**: every HTTP/control/runtime/model/tool/workspace event as a timed span. Bounded
  command identities (`shell:powershell.exe Get-ChildItem`); denials are first-class `policy.denied`
  evidence. Filters by category/status/text, *Errors only*, and the **Audit** table (actor → action
  → outcome rows, each linked to its source event).
- **Logs panel**: the Run's narrated story — spawn, first-output latency, session resumed/new,
  denials (coalesced), tool failures with exit hints, capability gaps, completion summary with
  tokens and model calls. Filter by level (info/warn/error).
- **Export JSON**: the complete redacted trace as one file — safe to hand to anyone, because
  redaction runs *before* persistence and fails closed.

### Capture policies

What the trace stores is governed by `GLASSBOX_CAPTURE_POLICY` (server-wide):

| Policy | Adds |
|---|---|
| `metadata_only` (default) | IDs, timings, counts, byte sizes, bounded command identities — no content |
| `safe_summary` | bounded redacted text: the prompt (240 chars), every agent message (240), command text (1024) + output tails (512), stderr tails, the Outcome line |
| `reasoning_summary` | everything above **plus** each model reasoning item as a 240-char redacted summary |

Raw prompts, completions and chain-of-thought are never stored at any policy. Summaries already
persisted remain readable after a policy downgrade.

## 5. Reliability & cost

Selecting an Agent shows its **Reliability panel**: execution/task completion rates (with evaluator
provenance), tool-failure and denial rates, token averages, latency p50/p95, and per-day sparklines.
With `GLASSBOX_PRICE_PER_MTOK_INPUT`/`_CACHED_INPUT`/`_OUTPUT` set, runs carry an estimated cost and
the metrics API aggregates it.

## 6. The verify chain: case → eval → comparison

This is how a good Run becomes a permanent check.

1. **Save as regression case** (trace header, on an `ok` Run): assertions are prefilled from the
   Run's own evidence — terminal status, expected tool, tool/duration budgets. You can edit the set;
   a **`post_check`** assertion (e.g. `npm test`, must be on `GLASSBOX_POSTCHECK_ALLOWLIST`) makes
   the platform re-run that command in the evaluation workspace — the strongest, model-independent
   signal. The case records the workspace template's content hash.
2. **Run against &lt;Agent&gt;** (Overview → Regression cases): an **EvalRun** replays the case's prompt
   through the real execution path in a *fresh* template copy and a fresh session, then evaluates
   every assertion with evidence links. If the template changed since the case was recorded, the
   run is refused with an explicit mismatch (you can force, and the dashboard shows the provenance).
3. **Compare evaluations** (needs two completed EvalRuns on the same case set): baseline vs
   candidate, per-assertion PASS/FAIL with deltas and evidence deep-links. Any PASS→FAIL is
   classified **REGRESSION** — deterministically, no LLM involved. A template mismatch between the
   two runs is flagged so you don't misread a template edit as a config regression.

Typical loop: baseline config → good Run → save case → change the Agent (instructions, model,
verify command — the config hash tracks it) → EvalRun → compare.

## 7. Troubleshooting

| Symptom | Meaning / fix |
|---|---|
| Failure bubble with 401 + hint chip | Provider rejected the key — fix `ARK_API_KEY` in `.env`, restart |
| Agent stuck `error` | Send another message, or Stop → Start |
| Every command denied, `0 files changed` | Sandbox resolved read-only (Windows local-process) — use the Docker path for write-heavy work |
| `post_check` "not allow-listed" | Add the command to `GLASSBOX_POSTCHECK_ALLOWLIST` |
| Eval refused: template changed | Re-record the case, or force and read the hash provenance |
| Outcome column empty | You're on `metadata_only` — set `safe_summary` to see it |

Windows-specific setup quirks: see the README's Run-it section.
