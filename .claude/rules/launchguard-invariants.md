---
paths:
  - "apps/server/src/launchguard/**"
  - "apps/server/src/codex-runner.ts"
  - "apps/server/src/container-codex-runner.ts"
  - "apps/server/src/agent-service.ts"
  - "apps/server/src/app.ts"
  - "Dockerfile.runtime"
  - "fixtures/**"
---

# LaunchGuard invariants (security-bearing code — never simplify these away)

1. **Default deny.** A protected action with no matching grant, unknown tool/operation, malformed request, or evaluator error is `deny`. No code path may fall through to `allow`.
2. **Authority is server-issued.** Leases, grants and decisions are created only in the control plane. Nothing the Runtime, model, or browser sends is trusted as a permission — only as a request.
3. **Canonicalise before matching.** Resolve `.`/`..`, percent-decode once, collapse `//` and `\`, lower-case, strip trailing `/`; reject anything that escapes the tenant root *before* glob matching.
4. **Credentials never cross the boundary.** The protected-resource credential lives only in the gateway process. It must not appear in `RunnerRequest`, container `--env`, `agentctl` args, events, errors, or API responses. Extend the runners' explicit env allow-lists; never pass `process.env` through.
5. **Check the lease at action time** (status, expiry, agent version/audience), not only at Run start.
6. **One-time grants are consumed atomically** with execution, inside the same `store.mutate`, keyed by `actionHash`; nonces are recorded before execution. Replay ⇒ `replay_detected`.
7. **Redact before persistence.** Every write of `parameterSummary`, tool results, or downstream errors goes through the redactor first. Canary strings (`CANARY-SECRET-`) must never reach `launchpad.json`, logs, `/api/runs/:id/events`, or the DOM.
8. **Fail closed on infrastructure errors** for protected writes (evidence store down ⇒ block). Reads may degrade only behind an explicit flag.
9. **No blind retries** for non-idempotent operations (`report.publish`).
10. **argv hygiene.** User/model strings reach `spawn`/`execFile` only as array elements after `--`; never build shell strings.
11. **Typed reason codes** from `docs/PRD.md` Appendix A; never an untyped 500 to the Agent.
12. **Baseline preserved.** Agent CRUD, Playground, session resume, stop/start, delete-archive and `npm run check` must keep working with LaunchGuard installed and with `LAUNCHGUARD_*` unset.

Any change touching 1–10 needs a negative test in the same commit and a pass from `launchguard-security-reviewer` before merge.
