# Observability roadmap — what GlassBox should capture next

_Tech-lead position, 28 August 2026 (main `a47447f`). Answers "what belongs in the observability portion — inputs, outputs, model reasoning?" with a concrete stance per signal, ranked against the judging rubric (40% end-to-end behavior · 25% design · 20% verification · 15% demo/repro). The full inventory of what is captured today lives in the tables below; PRD §4/§8 and `.claude/rules/glassbox-invariants.md` remain the constitution — nothing here relaxes them._

## 1. Where we stand

One correlated, privacy-safe trace per Run: 30 event types across 9 categories, per-turn token usage, per-call `modelCallsObserved` (#207/#230), bounded tool identities with durations and exit codes, sandbox denials as first-class `policy.denied` evidence, per-layer capability honesty (#212), workspace disk truth, first-failure focus with deterministic diagnosis, regression cases → isolated EvalRuns → comparison with evidence links. Two capture policies: `metadata_only` (default) and `safe_summary` (four bounded, redacted text fields). `full/raw` is prohibited by PRD §4, not merely unimplemented.

## 2. The stance on inputs, outputs, and reasoning

**Inputs (the user's prompt).** Keep prompt text out of the trace at `metadata_only` — that is the product's promise, and it is what lets us hand a judge the export file without a privacy review. What we owe the operator instead is *identity and drift*: today only `promptBytes` is recorded. Add a `promptHash` (sha256, first 16 hex) to `run.created` so identical re-asks correlate across Runs and configs without storing a word of the text. Under `safe_summary`, a redacted first-240-chars prompt summary is defensible (same bound and pipeline as the final-message summary) — worth doing only after the P0s below.

**Outputs (the agent's final message).** Already solved in shape: `finalMessageBytes` + `reportedFailure` always; the 240-char redacted summary and the Outcome line under `safe_summary`. The real gap is operational: the demo instance runs `metadata_only`, so the Outcome line — one of our best storytelling surfaces — is invisible (round 6 finding). **Decision: the demo runbook sets `GLASSBOX_CAPTURE_POLICY=safe_summary`.** That is a config choice, not new capture code.

**Model reasoning.** The answer stays no on content: chain-of-thought text is never captured (invariant #5, PRD §4), and this is a differentiator to *say out loud* in the demo, not a limitation to apologize for. What we do owe from the reasoning stream is its **shape**: we already count reasoning items into `modelCallsObserved`, and we already capture `reasoningOutputTokens` on `model.completed` — but `buildTrace` drops it (`query.ts` sums only input/cachedInput/output). Surfacing reasoning-token share ("2.1k of 13k output tokens were reasoning") is a one-line projection change plus a UI cell, and it answers a question operators actually ask (is this model thinking or thrashing?) with zero privacy cost.

**Per-call latency / time-to-first-token.** Structurally unavailable: `codex exec` emits one turn per prompt and the JSONL items carry no timestamps we can trust for call boundaries. Document it as a declared capability gap (we already have the vocabulary — `capability.unavailable` semantics) rather than approximating; invariant #3 says never fabricate. Revisit if a Codex upgrade adds item timestamps.

## 3. Ranked gaps

**P0 — before submission (moves the 40% and 15% axes):**
1. **Run-log narrative (#232, in flight).** The Logs panel's two lines per Run was the round-7 headline finding; an operator should be able to follow a Run from the log stream alone: spawn, first output, denials (coalesced), failures with exit hints, capability gaps, completion summary with tokens and model calls.
2. **Reliability dashboard (#173, open P0).** `POST /api/metrics/query` and both reliability endpoints are built, tested, and invisible — roughly a third of the computed API surface has no UI. This is finished backend value waiting for a front end.
3. **Demo policy + noise:** `safe_summary` in the runbook (above) and #202 (every ok template Run reads "Needs attention" via recovered chips — the first thing a judge will ask about).

**P1 — high value, contained effort:**
4. Surface `reasoningOutputTokens` (projection + one cell) and `cachedInputTokens` (already summed, never rendered — it is the cache-hit story on a 300k-token Run).
5. `promptHash` on `run.created` for cross-Run correlation.
6. **Cost as a first-class metric:** `estimatedCostUsd` exists (env-priced, baseline + per-run column) but is not in the metric catalogue, not persisted on RunSummary, and prices cached input at full rate. Fold it into the catalogue and price cached tokens separately.
7. Audit surface: `audit.actors[]` and `audit.denials` are computed and unshown; actor attribution is a trust story worth one row of UI.

**P2 — after the hackathon:** OTLP adapter wiring (stub exists), SSE (#40, gated on P0 per PRD), per-model pricing table, evaluations/jobs UI (#192), budget hooks (PRD §14 roadmap). Alerting stays out (PRD §17.5 explicit non-goal).

## 4. What we will not capture, ever

Raw prompts/completions at the default policy, chain-of-thought text at any policy, headers/env/credentials (redaction denylist + fail-closed), synthetic spans for missing runtime detail, LLM-generated diagnosis text. Every "capture more" proposal above is metadata, a hash, a count, or an already-bounded redacted summary — the invariants are the moat, and the judging story leads with them.
