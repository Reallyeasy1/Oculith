# PRD — LaunchGuard: runtime capability leases with verifiable action evidence

| | |
|---|---|
| **Track** | TikTok TechJam 2026 · Track 1 "Agent Launchpad: Design and Build Lightweight Agent Middleware" |
| **Repo** | github.com/Reallyeasy1/Oculith (built on the RrankPyramid/CodeJam Starter Kit) |
| **Status** | Draft v1 — 26 Aug 2026 |
| **Source** | *TikTok TechJam 2026 Track 1 Strategy* (25 Aug 2026) + Track 1 problem statement §1.1–1.12 |
| **One-liner** | Every Agent side effect should be scoped, explainable, and revocable. |

---

## 1. Problem statement

An Agent on the Starter Kit can reason, run shell commands, and read or write files, but the platform has **no boundary between what the model *wants* to do and what it is *allowed* to do**. Authority is implicit (whatever the container can reach), attribution collapses three actors into one (the human who started the Run, the Agent, and any downstream credential), and operators cannot reconstruct *why* an action happened from flat logs.

This is the gap Track 1 explicitly leaves open ("intentionally absent: no user identity, trace timeline, audit model, or hardened sandbox policy"). It is also the real-world failure mode behind OWASP's agentic top risks (goal hijack, tool misuse, privilege abuse): a malicious instruction embedded in *data* — an invoice, a web page, a tool result — becomes executable intent, and nothing server-side stops it. We observed this ourselves during baseline testing: asked for "ideas to improve this platform", the Agent walked out of its workspace into `../../src/*.ts` and read the control-plane source, because reads outside the workspace are unrestricted.

**Cost of not solving it:** the platform cannot be trusted with any protected resource, any human approval step is theatre (UI-only), and a compromised model equals a compromised system.

## 2. Product concept

**LaunchGuard** is a trusted runtime gateway that:

1. issues each Run a **short-lived capability lease** bound to Agent, Agent version, policy version and expiry;
2. **evaluates every protected action** (`allow | deny | approval_required`) deterministically, server-side, immediately before execution;
3. routes exceptional side effects to a **one-time human approval** bound to the exact action hash;
4. supports **revocation** that takes effect on the next action, not the next Run;
5. records a **redacted evidence timeline** correlated by Run/trace/decision IDs.

**The promise is not that the model cannot be manipulated. It is that manipulation does not automatically become authority.**

## 3. Goals

| # | Goal | How we know |
|---|---|---|
| G1 | A protected action requested by the Agent is decided by the backend, not the UI or the model | Direct calls to the protected resource from inside the Runtime fail; only gateway-authorised calls succeed |
| G2 | A prompt-injected request for another tenant's resource is denied with **zero state mutation** | Tenant-B fixture byte-identical before/after the malicious Run; `DecisionEvent` with `reasonCode=wrong_tenant` recorded |
| G3 | Human approval is narrow and real | A publish action pauses, shows exact target + parameters, executes exactly once after approval; replay of the same grant returns `replay_detected` |
| G4 | Authority is revocable mid-Run | Revoking the lease between two actions makes the second one fail with `lease_revoked` |
| G5 | Evidence is safe by construction | Seeded canary secrets never appear in the JSON store, logs, API responses or browser; 100 % of decisions carry `runId` + `traceId` |
| G6 | Baseline preserved and reproducible | Starter-kit acceptance test still passes; `npm run check` green; one-command local start; demo ≤ 2:45 |

## 4. Non-goals

| Non-goal | Why |
|---|---|
| Production OAuth / SSO / login flow | Brief says mock users suffice; a login screen without server-side authz scores nothing |
| General-purpose policy DSL | Parser/precedence/bypass risk unrelated to the demo; a fixed JSON schema with two tools is enough |
| Intercepting arbitrary shell or syscalls | Impossible in 3 days and not the claim; the claim is "the Agent cannot reach *this* protected service except via LaunchGuard" |
| Hardened multi-tenant sandbox / microVM | Starter kit's container limits remain the baseline safeguard, not our contribution |
| Prompt-injection *detection* as the guarantee | Probabilistic arms race with a known utility/security trade-off (AgentDojo, ARGUS); we constrain authority instead |
| OpenTelemetry collector / trace database | A vertical event list in the existing UI is sufficient evidence; OTel-compatible export is a stretch goal |

## 5. Users & user stories

**Personas:** Platform operator · Developer debugging a Run · Resource owner (tenant) · Approver.

**P0 stories (demo-critical)**
- As a **platform operator**, I want to assign a policy profile to an Agent so that it can act without holding an open-ended service credential.
- As a **resource owner (tenant A)**, I want proof that an Agent owned by another tenant cannot read or write my resource, even when the model is tricked into asking.
- As an **approver**, I want to see the exact tool, operation, normalised target and parameter summary before I authorise a state-changing action, so approval is informed and narrow.
- As an **approver**, I want my approval to apply exactly once to exactly that action, so a retry or replay cannot reuse it.
- As a **platform operator**, I want to revoke an Agent's lease during a Run so that the next protected action is denied.
- As a **developer**, I want a per-Run timeline of decisions with reason codes so I can see why an action was allowed, denied or paused.

**P0 edge stories**
- As a **developer**, when the lease has expired, is revoked, forged, or has the wrong audience, I want a typed denial (not a generic 500) so the Agent can stop or degrade explicitly.
- As a **resource owner**, I want `../`, encoded traversal, doubled separators and case variants of my resource path to be denied, so the policy cannot be bypassed by string tricks.
- As a **platform operator**, when the evidence store is unavailable, I want protected *writes* to fail closed so no mutation goes unrecorded.

**P1 stories**
- As a **developer**, I want the Agent to receive a structured error it can act on (retry safely, ask for approval, or stop) rather than an opaque failure.
- As a **judge/reviewer**, I want one command to reset fixtures and evidence so the demo is reproducible from a clean state.

## 6. Requirements

### 6.1 Must-have (P0)

| ID | Requirement | Acceptance criteria |
|---|---|---|
| R1 | **Policy profile per Agent** — JSON profile (`default: deny`, `grants[]`, `limits`) selectable on the Agent; versioned | Agent detail shows profile name + version · backend rejects unknown profile with 400 · profile stored in `launchpad.json` |
| R2 | **Run-scoped capability lease** — created in `AgentService.sendMessage` when the Run starts; opaque server-generated ID; bound to `agentId`, `agentVersion`, `policyVersion`, `expiresAt` (default 900 s); status `active|expired|revoked` | Run start fails closed if lease creation fails · lease passed to Runtime via env, never the downstream credential · `POST /api/leases/:id/revoke` flips status and the next action is denied |
| R3 | **ActionRequest / PolicyDecision contract** — Runtime submits `{runId, traceId, leaseId, agentId, agentVersion, tool, operation, resource, parameterSummary, nonce}`; gateway returns `{decisionId, policyVersion, effect, reasonCode, normalizedResource, actionHash, expiresAt}` | Zod-validated at the route · `effect ∈ {allow, deny, approval_required}` · `reasonCode` from Appendix A |
| R4 | **Deterministic evaluator** — canonicalise target (resolve `..`, decode `%xx`, collapse `//`, lower-case, strip trailing `/`), then match `tool`+`operation`+`resource` glob against grants; missing match ⇒ deny | Table-driven tests: allow, deny, approval, default deny, target mismatch, expiry, revocation, replay, traversal & encoding variants · same input + policy version ⇒ same output |
| R5 | **Protected adapter (`agentctl`)** — small CLI baked into `Dockerfile.runtime`; the *only* path from the Runtime to the protected mock resource; talks to the gateway over HTTP; downstream credential lives only in the gateway process | `curl` from inside the Runtime container to the resource directly fails (network/credential) · `agentctl resource read tenant-a/invoices/A-1024` succeeds under an `allow` grant |
| R6 | **Protected mock resource** — seeded local fixtures for tenant A and tenant B (invoices, reports); write operation `report.publish` | Fixture files under a path not bind-mounted into the Runtime · reset script restores them |
| R7 | **One-time approval** — `approval_required` creates `Approval{pending}`; UI card shows tool, operation, normalised target, parameter summary; `approve` issues a grant bound to `actionHash`; grant consumed on first use | Retried identical action executes once · second identical request ⇒ `replay_detected` · `reject` ⇒ `deny` with `approval_rejected` · pending approval expires with the lease |
| R8 | **Evidence timeline** — append-only `DecisionEvent`/`ActionResult` records per Run (`run_started, action_requested, policy_decided, approval_requested, approval_resolved, action_started, action_succeeded, action_failed, run_completed`); `GET /api/runs/:id/events`; vertical list in the Run view | Every event carries `runId`, `traceId`, `actorType`, `agentId/version`, `policyVersion`, `reasonCode`, duration · UI shows them in order with status colour |
| R9 | **Redaction before persistence** — parameter summaries and downstream errors pass through a redactor (secret markers, bearer tokens, env-shaped strings, raw payloads > N chars) | Seeded canary `CANARY-SECRET-…` injected into prompt, tool result, error message and arguments never appears in `launchpad.json`, server log, `/api/runs/:id/events`, or the DOM |
| R10 | **Typed failure semantics** — denial, expiry, revocation, replay, downstream timeout, audit-store failure each map to a reason code and an explicit Run outcome; no blind retry for non-idempotent writes | Injected evidence-store error on a publish ⇒ action fails, fixture unchanged · downstream timeout ⇒ `action_failed`, fixture unchanged |
| R11 | **Baseline preserved** — Agent CRUD, Playground, session resume, stop/start, delete-archive unchanged | Starter-kit acceptance test passes · `npm run check` passes |
| R12 | **Reset script** — `scripts/reset-demo.sh` restores fixtures, clears leases/approvals/events, keeps Agents | Two consecutive demo runs from reset produce identical evidence shape |

### 6.2 Nice-to-have (P1, in priority order)

1. Policy version diff and rollback on the Agent detail view.
2. Decision export with OpenTelemetry GenAI-compatible attribute names.
3. Per-Run action budget (`maxExternalWrites`), timeout and concurrency limit enforced by the gateway.
4. Configurable fail-closed vs degraded-audit mode.
5. `agentctl` returning structured hints so Codex can self-recover (ask for approval / stop).

### 6.3 Future considerations (P2 — design for, don't build)

- Second provider adapter behind the same `ActionRequest` contract (e.g. a mock Git or HTTP publish target).
- HMAC-signed leases (key in process memory only) instead of opaque IDs.
- Resource provenance hints for high-risk arguments (context-aware authz).
- Multi-user ownership (User A / User B) layered on the same lease model.

## 7. Architecture & trust boundary

```
Browser (React) ──► Fastify control plane ──► AgentService ──► AgentRunner ──► Codex in disposable container
   policy panel        /api/actions            RunContext        (lease id      │
   approval card       /api/approvals          + Lease            in env)        │ agentctl <tool> <op> <resource>
   evidence list       /api/runs/:id/events         │                            ▼
                             │                      │                     Policy gateway  ──► Protected adapter ──► Mock resource
                             ▼                      ▼                     (evaluate, grant,    (holds credential;    (tenant A / B
                       JSON store  ◄──── DecisionEvent / ActionResult      consume, redact)     executes only          fixtures,
                       launchpad.json                                                            authorised requests)   outside mounts)
```

**Trust boundary:** the *gateway process* (Fastify) is trusted; the Runtime container, the model output, workspace files and browser state are untrusted. The protected credential never enters the container's environment (`ContainerCodexRunner` already allow-lists env vars — only the lease ID is added).

| Component | Owns | Fails how |
|---|---|---|
| React UI | policy selection, approval card, evidence list | UI failure can never turn deny into allow |
| RunContext (in `AgentService`) | bind user, Agent/version, policy version, traceId, leaseId | Run start fails closed |
| Policy gateway (new server module) | normalise, evaluate, grant, consume, revoke | typed denial; no downstream call |
| Protected adapter | credential + execution | typed downstream error; credential never returned |
| Evidence store (`JsonStore`) | append redacted events | protected writes fail closed |
| `agentctl` (Runtime image) | stable CLI contract for protected actions | structured error to Codex |

**Untrusted:** user prompt, invoice text, model output, requested arguments, workspace files, browser state.
**Trusted:** policy document, lease store, approval record, target canonicaliser, downstream credential, server clock.

### Example policy profile

```json
{
  "name": "finance-reporter", "version": 1, "default": "deny",
  "grants": [
    { "tool": "resource", "operation": "read",    "resource": "tenant-a/invoices/*", "effect": "allow" },
    { "tool": "report",   "operation": "publish", "resource": "tenant-a/reports/*",  "effect": "approval_required" }
  ],
  "limits": { "leaseSeconds": 900, "maxExternalWrites": 1 }
}
```

### Request flow
1. `POST /api/agents/:id/messages` → `AgentService` creates Run + RunContext + Lease, passes `LAUNCHGUARD_LEASE_ID` and `LAUNCHGUARD_URL` to the Runtime.
2. Codex runs `agentctl resource read tenant-a/invoices/A-1024` → `POST /api/actions` (ActionRequest).
3. Gateway validates lease, canonicalises target, computes `actionHash`, evaluates against the pinned policy version, appends `policy_decided`.
4. `allow` → adapter executes, `action_succeeded`. `deny` → typed error to `agentctl`. `approval_required` → `Approval{pending}` + `approval_requested`; `agentctl` blocks (long-poll) or returns `approval_required` for the Agent to retry.
5. Operator approves in the UI → one-time grant bound to `actionHash` → the exact action executes once, grant consumed.

## 8. Threat model (what the demo and tests must prove)

| Threat / failure | Control | Proof |
|---|---|---|
| Injected invoice requests tenant B data | tenant-bound resource glob, default deny | denial event; tenant B fixture unchanged |
| Confused deputy / shared token | audience-bound lease; credential held by gateway only | direct call from Runtime fails |
| Path / target bypass | canonicalise before match | table tests for `../`, `%2e%2e`, `//`, case |
| Approval replay | grant bound to `actionHash`, consumed once | second identical request ⇒ `replay_detected` |
| Revocation race | lease checked per action | revoke between two actions ⇒ second denied |
| Sensitive evidence | redact before persist | canary absent from store/log/API/DOM |
| Downstream timeout | typed error, no blind retry for writes | fixture unchanged |
| Evidence store down | fail closed for protected writes | injected store error blocks mutation |

## 9. Success metrics

**Leading (measured in tests / demo)**
- Unauthorised mutations of protected fixtures: **0** across the full negative suite.
- Decision-branch and reason-code coverage in evaluator unit tests: **100 %**.
- Canary secrets persisted or displayed: **0**.
- Gateway decision overhead (excluding human wait), p95 on local POC: **< 50 ms**.
- Decisions carrying `runId` + `traceId`: **100 %**.
- Live demo duration from reset: **≤ 2:45**; `npm run check` passes twice from clean state.

**Lagging (judging rubric alignment)**
- End-to-end middleware behaviour (40 %): real browser → control plane → Runtime → gateway → mutation/denial → timeline.
- Technical design (25 %): explicit boundary, lease, deterministic contract, server-held credential, minimal baseline changes.
- Verification & robustness (20 %): default-deny, cross-tenant, traversal, expiry/revocation/replay, redaction, unchanged-state assertions.
- Demo & reproducibility (15 %): local fixtures, one-command POC, reset script, README, diagram, stated limitations.

## 10. Open questions

**Blocking (answer before Day 1 PM)**
- *Engineering:* How does `agentctl` inside the container reach the gateway on the host? Docker Desktop offers `host.docker.internal`; Linux needs `--add-host=host.docker.internal:host-gateway` in `ContainerCodexRunner`. Also: `--network bridge` currently gives the container unrestricted egress — do we restrict it, and does that break ModelArk?
- *Engineering:* Approval as long-poll inside the Codex tool call (Run stays `running`) vs. return-and-retry (Agent re-invokes after approval)? Long-poll is simpler for the model; return-and-retry is safer against `CODEX_TIMEOUT_MS`.
- *Workshop 28 Aug:* Is modifying `Dockerfile.runtime` to add `agentctl` acceptable? Is a Run pause/approval sub-status an accepted lifecycle extension?

**Non-blocking**
- *Engineering:* Does the Codex sandbox fallback to `danger-full-access` (Landlock unavailable under Docker Desktop) matter for the demo narrative? Our claim is scoped to the protected resource, so no — but state it as a limitation.
- *Team:* Does the demo Agent reliably attempt the injected action live? Keep the scripted `ActionRequest` fixture as fallback (containment is the proof, not model failure).
- *Team:* Store new records in `launchpad.json` (extend `Database`) or a second JSON file? Extending is fewer moving parts; watch file size from events.

## 11. Timeline

| Window | Work | Exit evidence |
|---|---|---|
| Pre-event (done 26 Aug) | Clone, baseline acceptance in Docker, `npm run check`, BytePlus config | ✅ baseline completes, session resumes, workspace persists |
| 28 Aug | Track 1 workshop 1:00–1:45 pm SGT — ask the blocking questions above | answers recorded here |
| Day 1 AM | Contracts (`types.ts`), policy schema, fixtures incl. malicious invoice | contracts reviewed; negative fixture committed |
| Day 1 PM | Evaluator + canonicaliser + lease store + mock resource + direct-call denial | API test: one real allow, one real deny |
| Day 2 AM | `agentctl` in Runtime image; RunContext in `AgentService`; events | E2E benign read + denied cross-tenant read |
| Day 2 PM | Approval pause/resume, one-time grant, revoke, minimal UI (policy panel, approval card, timeline) | approval executes once; replay & revoked lease denied |
| Day 3 AM | Redaction, timeout/error paths, reset script, unit/table/integration/E2E tests | all green; zero canaries |
| Day 3 PM | **Feature freeze.** Architecture page, README, limitations, fallback recording, rehearsal | `npm run check` ×2 from clean; demo < 2:45 |

**Critical-path rule:** no approval UI, trace polish or stretch work until one protected action is denied by the backend and a test proves the resource unchanged.

**Team ownership:** control plane (RunContext, evaluator, lease/approval, evidence API) · Runtime/infra (`agentctl`, adapter, credential boundary, failure fixtures) · frontend + verification/demo (policy panel, approval card, timeline, negative tests, reset, README, rehearsal). One person owns final scope decisions.

## 12. Demo script (3 min)

| Time | Show | Judge concludes |
|---|---|---|
| 0:00–0:20 | Select *Finance Reporter*; policy summary + version | authority is explicit before execution |
| 0:20–0:55 | Run: read invoice A-1024, write local summary, publish | baseline path works; real model + file action |
| 0:55–1:25 | Publish pauses; approval card shows tenant/target/op/one-time scope; approve | approval is narrow and tied to a real side effect |
| 1:25–1:45 | Report appears in protected fixture; allow/approval/success events | behaviour is visible and attributable |
| 1:45–2:25 | Open malicious invoice asking for tenant B; run Agent | untrusted data influences the model, not authority |
| 2:25–2:45 | Denial event; tenant B fixture unchanged; (optional) revoke → next action denied | failure contained, evidence convincing |
| 2:45–3:00 | `npm run check` result; architecture page; two limitations | reproducible, focused, honest |

## Appendix A — Reason codes & events

- **Effect:** `allow`, `deny`, `approval_required`
- **Denial reason:** `no_matching_grant`, `wrong_tenant`, `target_mismatch`, `operation_not_allowed`, `lease_expired`, `lease_revoked`, `wrong_audience`, `replay_detected`, `invalid_target`, `approval_rejected`, `audit_unavailable`
- **Approval status:** `pending`, `approved`, `rejected`, `expired`, `consumed`
- **Run events:** `run_started`, `action_requested`, `policy_decided`, `approval_requested`, `approval_resolved`, `action_started`, `action_succeeded`, `action_failed`, `run_completed`
- **Safe to persist:** `runId`, `traceId`, `actorType`, `agentId/version`, `policyVersion`, `tool`, `operation`, normalised target class, `actionHash`, `reasonCode`, duration, result status
- **Never persist by default:** raw credential, bearer token, full environment, unrestricted prompt/tool payload, secret file contents, unredacted downstream error

## Appendix B — Sources

1. TikTok TechJam 2026 Track 1 problem statement (Early Bird), §1.1–1.12.
2. OWASP Top 10 for Agentic Applications 2026.
3. NIST AI 100-2e2025, §3.4–3.5 (assume injection remains possible; constrain via defined interfaces).
4. Debenedetti et al., *AgentDojo*, NeurIPS 2024.
5. MCP Security Best Practices (2026-07) — token passthrough, confused deputy, audience validation.
6. OpenTelemetry, *GenAI Observability* (May 2026) — content capture is optional.
7. He et al., *Progent* (2025); 8. Weng et al., *ARGUS* (May 2026, emerging).
