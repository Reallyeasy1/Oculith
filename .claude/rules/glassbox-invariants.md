---
paths:
  - "apps/server/src/glassbox/**"
  - "apps/server/src/codex-runner.ts"
  - "apps/server/src/container-codex-runner.ts"
  - "apps/server/src/agent-service.ts"
  - "apps/server/src/app.ts"
  - "fixtures/**"
---

# GlassBox invariants (trust-bearing code — never simplify these away)

1. **Redact before persistence.** Every event passes `RedactionPipeline` (allowlist operational fields → drop keys `authorization|apiKey|token|secret|password|cookie|privateKey` case-insensitively → bounded pattern scan → truncate) *before* it reaches disk, API, export, or log. One serializer for all surfaces; no bypass flag exists.
2. **Fail closed on redaction error.** If the redactor throws or is uncertain, persist metadata only with `privacy.redacted=true, privacy.reason="redaction_failed_closed"`. Never persist the raw payload "just this once".
3. **Never fabricate evidence.** Emit only what a component actually observed. If the runtime/provider doesn't expose model/tool detail, emit `capability.unavailable` once and keep the real runtime span. No synthetic spans for presentation. Diagnosis text is derived deterministically from stored events — no LLM in the diagnosis path.
4. **Telemetry never breaks the Run.** `ObservationEmitter` is non-blocking and swallows its own errors into a log-safe `telemetry.degraded`; a `TraceStore` failure must not change the Run's real terminal state.
5. **No raw content, ever.** Capture policy is `metadata_only` by default; `safe_summary` opt-in adds bounded, filtered text; `reasoning_summary` opt-in (#259) adds everything `safe_summary` does plus reasoning text **only** as bounded (240-char) redacted summaries — raw chain-of-thought is never stored at any policy, reasoning summaries never appear by default, and `full/raw` is not implemented — do not add it.
6. **Stable IDs and ordering.** `traceId`, `spanId`, `runId`, `requestId`, `actorId`, `sequence` follow `docs/PRD.md` §8. `sequence` is monotonic per trace; `eventId` is unique and duplicate appends are idempotent (no double counts).
7. **Status semantics are exact.** `running | ok | error | cancelled | timeout | unset`. A parent turns `error` only when an unhandled descendant error reaches the Run. Incomplete spans are marked incomplete — never guessed closed.
8. **Instrument the seams, don't bypass them.** Adapters live in `app.ts` (hooks), `agent-service.ts`, and the two runners. The controlled-failure fixture goes through the same `AgentService → AgentRunner` path and is gated by `GLASSBOX_DEMO_FAILURE`; off by default.
9. **Emitters never import UI or query code.** Dependency direction: adapters → emitter → redact → store ← query ← routes ← UI.
10. **Bounded storage is observable.** Caps (1,000 events/Run, 32 KB/event, 10 MB/Run) drop content-bearing events first, keep terminal/error metadata, and record `trace.truncated`.
11. **Versioned contract.** Changing `ObservationEvent` bumps `schemaVersion`; the query API always returns `schemaVersion` and `capturePolicy`.
12. **Baseline preserved.** Agent CRUD, Playground, session resume, stop/start, delete-archive and `npm run check` keep working with GlassBox installed.

Any change touching 1–5 needs a privacy/degradation test in the same commit and a pass from `glassbox-privacy-reviewer` before merge.
