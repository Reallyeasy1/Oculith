# TikTok TechJam 2026 — Track 1 problem statement

_Transcribed from "[Early Bird Access] TikTok TechJam 2026 Tracks & Problem Statements" (Feishu, retrieved 25 August 2026) so the requirements travel with the code. Wording is the organisers'; only layout was normalised. Starter Kit: <https://github.com/RrankPyramid/CodeJam>. Technical workshop webinar: 28 August 2026, 13:00–13:45 SGT. The last section maps each requirement to where Oculith addresses it._

## 1. Agent Launchpad: Design and Build Lightweight Agent Middleware

> **Build the missing middleware, not the platform.**
> The Starter Kit already provides the browser UI, Agent CRUD, Playground, backend control plane, persistent workspaces, Codex CLI Runtime, BytePlus ModelArk integration, local containers, and optional ECS deployment. Identity and authorization, trace and audit, layered Agent architecture, and threat modeling and safety are recommended middleware examples — not a prescribed checklist. Teams may choose, combine, simplify, replace, or invent capabilities that make the Agent platform more usable, manageable, observable, secure, reliable, or extensible.

### 1.1 Challenge overview

AI Agents are software actors that can reason, call tools, execute code, read and write files, and continue work across multiple turns. A useful Agent platform therefore needs more than a chat box: operators must be able to understand what happened, control what an Agent may access, and contain unsafe execution.

Building the full web application, control plane, cloud deployment, model connection, and Agent Runtime from scratch would consume the entire hackathon. This challenge removes that bottleneck. Every team starts from the same working platform and spends the three days on one meaningful infrastructure problem.

**Your goal:** design and demonstrate a coherent middleware story that improves the Agent platform in a functional, testable way without breaking the provided lifecycle or Playground. Evaluation focuses on the relevance, quality, and integration of the capabilities your team chooses or invents.

| Area | Provided by the Starter Kit | Student responsibility |
|---|---|---|
| Product experience | React UI, Agent list, Create/Edit forms, lifecycle controls, Playground, Run status | Keep the baseline working; add only the UI needed to expose your middleware |
| Control plane | Fastify API, validation, asynchronous Runs, `AgentService`, JSON persistence | Integrate real middleware behavior into the backend path |
| Agent Runtime | Codex CLI, persistent sessions, per-Agent workspaces, disposable local containers | Integrate team-designed middleware at the most appropriate execution boundary |
| Infrastructure | Docker, Colima, Podman, Docker Compose, ECS scripts, and Terraform | Use the smallest runtime path that proves your design. Cloud deployment is optional |
| Middleware | Intentionally absent: no user identity, trace timeline, audit model, or hardened sandbox policy | Select, adapt, combine, or invent a coherent set of middleware capabilities and demonstrate why they improve the platform |

### 1.2 Starter Kit

**What already works**

- Create, inspect, edit, start, stop, and delete Agents from the browser.
- Send multi-turn tasks through the Playground and poll asynchronous Run status.
- Let Codex CLI write files and run commands inside the selected Agent workspace.
- Resume the same Codex session in later messages.
- Persist Agent, message, and Run metadata in a local JSON store.
- Run each local turn in a disposable Docker, Colima, or Podman container.
- Connect Codex to a BytePlus ModelArk Responses-compatible endpoint.
- Deploy the same POC to an existing BytePlus ECS instance or provision an ECS environment with Terraform.

**Current architecture and extension points.** The Fastify request boundary, `AgentService`, the `AgentRunner` interface, and the execution data model are all valid extension seams. The diagram deliberately uses one generic Team-Designed Middleware node: teams may add new events, principals, policies, lifecycle behavior, provider adapters, memory controls, reliability mechanisms, or other capabilities wherever their design has the strongest boundary.

| Profile | Agent execution | Use during the hackathon |
|---|---|---|
| Local POC | One disposable local container per turn | Recommended development and judging path. Supports Docker, Colima, and rootless Podman |
| BytePlus ECS | Codex runs inside the application container | Optional deployment path for teams that want a cloud demo |
| Local development | Codex runs as a host process | Useful for hot reload when the host Codex CLI is installed and configured |

**Intentional limitations.** The repository is a single-user POC. Its optional bearer token protects a remote demo but is not a user identity or authorization system. The JSON store supports one process. Ordinary containers are not a hardened multi-tenant isolation boundary. These limitations are deliberate extension points, not hidden requirements to fix all at once.

### 1.3 Run the baseline locally

Requirements: macOS or Linux; Node.js 22 or newer and npm 10 or newer; one container engine (Docker, Colima, or Podman); a BytePlus ModelArk API key and a Responses-compatible endpoint ID.

```bash
git clone https://github.com/RrankPyramid/CodeJam.git
cd CodeJam
ARK_API_KEY=your-ark-api-key ARK_MODEL=ep-your-endpoint-id npm run poc
```

The first run installs Node.js dependencies and builds the Runtime image. The startup script automatically selects Docker, Colima, or Podman. Open <http://localhost:3000> when the server is ready. `ARK_API_KEY` must be an Ark model API key, not a BytePlus account AK/SK; `ARK_MODEL` is normally an endpoint ID beginning with `ep-`. A wrong credential produces `401 Unauthorized` from the Ark Responses API. Force rootless Podman with `CONTAINER_ENGINE=podman`. Colima exposes the Docker CLI after `colima start`. Ctrl-C stops the POC; Agent workspaces and conversations remain available for the next run.

**Baseline acceptance test**

1. Open the browser and select Create Agent.
2. Enter a name, description, and workspace instructions.
3. Create the Agent and send the task: _"Create a TypeScript hello-world CLI, add a test, run it, and summarize the files"_.
4. Wait for the Run to complete and confirm that an assistant response appears.
5. Send a follow-up message and confirm that the same Codex session continues.
6. Stop and restart the Agent, then confirm that the workspace still exists.

Do not start middleware work until this flow succeeds. If the baseline fails, check `docker info` or `podman info`, inspect `http://localhost:3000/api/system`, and verify the Ark key and endpoint.

**Development and validation.** Edit the code, stop the POC, and rerun `npm run poc`. Before submitting, run `npm run check` (TypeScript checks, server tests, and production builds). Additional setup paths are documented in the repository: README and browser SOP; Docker, Colima, and rootless Podman guide; architecture and extension seams; optional ECS deployment guide.

### 1.4 Platform and middleware design requirements

The Starter Kit defines the basic platform experience. Beyond that baseline, middleware design is the core of the challenge. Teams should identify an Agent-specific problem, decide which responsibilities belong in the frontend, control plane, Runtime, data layer, or infrastructure boundary, and implement the smallest coherent solution that proves the idea. The directions in 1.7 are examples rather than mandatory requirements. Breadth is not the goal: reviewers will reward a clear problem, thoughtful architecture, real integration, and convincing evidence.

- **Preserve the baseline:** Agent CRUD, lifecycle actions, Playground chat, persistence, and model execution must continue to work.
- **Implement real behavior:** the middleware must execute in a backend, Runtime, data, or infrastructure path. Static screens and hard-coded success messages do not qualify.
- **Define the boundary:** explain which component owns the decision or event, what data crosses the boundary, and what happens when it fails.
- **Demonstrate meaningful evidence:** show the normal behavior and an appropriate failure, denial, recovery, degraded, or abuse case for the team's design.
- **Add automated verification:** test the core middleware behavior rather than only rendering the UI.
- **Keep secrets out:** never commit or display API keys, AK/SK, passwords, bearer tokens, or unredacted sensitive payloads.
- **Prefer the smallest useful infrastructure:** local execution is the default judging path; ECS is optional and does not affect the score.

| In scope | Out of scope |
|---|---|
| A coherent middleware story with one or more related capabilities, a real integration path, minimal UI, tests, and demo evidence | Rebuilding the React app, CRUD API, Playground, Codex integration, container launcher, or a commercial cloud platform |
| Mock users, protected fixtures, controlled failures, provider adapters, lifecycle controls, trace data, policy decisions, or reliability mechanisms | Production OAuth, a general-purpose policy engine, a microVM runtime, a container scheduler, or multi-region infrastructure unless central to the team's idea |
| Focused schema changes and refactors needed to make the middleware understandable and extensible | Unrelated redesigns or cosmetic work that does not prove Agent infrastructure behavior |

### 1.5 Agent lifecycle and post-creation experience

The Starter Kit already provides a post-creation experience: a user can find an Agent, inspect its status and configuration, start or stop it, use the Playground, review messages and Runs, continue a Codex session, and delete the Agent while following an explicit workspace archival policy. Teams may extend this lifecycle when it supports their middleware design; the following are examples rather than mandatory checkpoints:

- Test or invoke the Agent with a sample input.
- Open the middleware evidence for a specific Run, such as a trace, audit decision, policy result, recovery record, or budget event.
- Distinguish human operations from Agent operations and introduce human approval where useful.
- Update configuration through a new version and show what changed.
- Rotate or revoke credentials, permissions, tools, or network access.
- Pause, resume, stop, retry, reconcile, or recover an Agent or Run.
- Delete the Agent and clean up or retain its state according to an explicit policy.

Implement only the lifecycle behavior needed to make the chosen capability convincing.

### 1.6 Possible three-day implementation plan

| Day | Engineering goal | Exit evidence |
|---|---|---|
| 1 | Start and understand the baseline. Define the Agent-specific problem, choose or invent a coherent middleware story, specify the contract, and complete the first backend path | The baseline passes; the team can trigger one real middleware behavior, event, decision, or control from an API or test |
| 2 | Finish the core middleware path, persist its evidence, add the minimum UI, and implement the most important success and failure cases | The complete scenario works end to end from the browser to the backend, Runtime, data, or infrastructure boundary |
| 3 | Add automated tests, handle errors and cleanup, finish the architecture diagram and README, then rehearse the demo | `npm run check` passes and the complete demonstration fits within three minutes |

### 1.7 Recommended middleware directions and examples

Recommended examples, not a prescribed checklist: identity and authorization; **trace, audit, and observability**; layered Agent architecture; threat modeling and safety; multi-Agent coordination; other team-designed middleware (lifecycle reconciliation and failure recovery, state and memory governance, human-in-the-loop workflows, cost and budget control, provider abstraction, versioning and rollback, tool or model routing, credential exchange, automated diagnosis and remediation). A team-defined capability should still explain the Agent-specific problem, architecture boundary, functional evidence, failure or recovery case, and known limitations.

**Trace, audit, and observability (Oculith's chosen direction).** A team choosing this area could represent an Agent Run as a connected sequence of reasoning and actions rather than unrelated logs. Trace context may propagate across the frontend, control plane, Agent Runtime, model calls, tool calls, workspace operations, sandbox jobs, or cloud APIs that are relevant to the team's design. Possible ideas:

- Stable identifiers such as Agent ID, Agent version, Run ID, session ID, trace ID, span ID, and actor type.
- Start time, duration, status, error details, and retry or cancellation relationships.
- Span categories such as orchestration, model call, tool call, memory access, sandbox execution, policy decision, human approval, or cloud operation.
- Inputs and outputs stored in a safely summarized or redacted form.
- Model, tool, Runtime, and infrastructure metadata needed to diagnose a Run.
- Token usage, cost, resource consumption, or other budget signals when available.

A trace-focused frontend could provide a Run list and a trace detail view with a tree or timeline, expandable spans, status filters, and a way to locate the failing step. A machine-readable query or export interface is an optional extension. Secrets and sensitive payloads should be redacted before storage or display.

**Layered Agent architecture (illustrative, may be adapted).**

| Layer | Primary responsibility | Illustrative Starter Kit boundary |
|---|---|---|
| Experience | Agent creation, catalog, Playground, middleware evidence, lifecycle actions | React web UI calling stable platform APIs without holding the Ark key |
| Control plane | Agent specification, validation, status, Run orchestration, reconciliation | Fastify routes and `AgentService` |
| Identity and policy plane | Human and Agent identity, delegation, approval, revocation, audit | A team-designed boundary around API, service, tool, or Runtime operations |
| Agent Runtime | Codex execution, model access, tool routing, retries, cancellation, limits | `AgentRunner`, local Runtime containers, or the ECS process |
| Execution and data | Workspace files, persistent state, protected resources, connectors, isolated execution | Per-Agent workspaces, JSON metadata, mock services, provider adapters |
| Observability | Trace ingestion, correlation, redaction, storage, query, visualization, export | New Run events, stores, APIs, and UI views added by the team |
| Cloud resource | Compute, networking, storage, scheduling, sandbox infrastructure | Docker, Colima, Podman, or optional BytePlus ECS |

**Threat modeling and safety (controls to consider).** Credential theft or exposure → managed secret references, short-lived credentials, rotation, redaction, exclusion of secrets from source, browser state, logs, and traces. Privilege escalation or confused delegation → least-privilege scopes, explicit delegation, backend policy checks, approvals, revocation, complete actor attribution. Prompt injection or tool misuse → tool allowlists, typed schemas, target-resource scoping, output validation, execution limits, approval for high-risk actions. Sandbox escape or untrusted code → non-privileged execution, restricted filesystems and networks, resource limits, controlled mounts, patched Runtime images. Cross-user access or data exfiltration → ownership-aware authorization, storage isolation, scoped queries, outbound allowlists, protected metadata endpoints, negative tests. Runaway execution or cost → timeouts, quotas, concurrency limits, maximum steps, token or cost budgets, an administrative stop control. **Sensitive trace capture → configurable capture levels, redaction before export, trace access control, retention limits.** The Starter Kit's existing CPU, memory, PID, dropped-capability, and `no-new-privileges` defaults may be reused as baseline safeguards but do not by themselves constitute a new safety capability.

### 1.8 Required live demo

The live demo should show one complete scenario. The essential journey is a user creating or selecting a runnable Agent from the frontend and then using or testing it; beyond that baseline, each team demonstrates the middleware it chose or designed.

1. Create or select an Agent from the frontend and show its current lifecycle state.
2. Invoke the Agent through the Playground with a real task.
3. Show at least one real model, file, tool, sandbox, data, or infrastructure action.
4. Demonstrate the middleware behavior and the evidence it produces.
5. Demonstrate an appropriate failure, denial, degraded, abuse, or recovery case.
6. Show that the platform remains understandable and controllable afterward.

The scenario may use a mock third-party service or controlled fixture. The frontend-to-Agent path and any middleware presented must be functional rather than represented only by static screens.

### 1.9 Deliverables

1. **Three-minute live demo:** one real Agent Run and the team-designed middleware working in its normal case and an appropriate failure, denial, recovery, degraded, or abuse case.
2. **One-page architecture diagram:** the middleware, data flow, trust boundary, and enforcement, instrumentation, or recovery point.
3. **Code repository:** setup instructions, the middleware problem and rationale, design summary, automated tests, demo steps, limitations, and no secrets.

### 1.10 Core acceptance checklist and optional evidence

- A reviewer can clone the repository, start the platform, and create or test an Agent from the frontend.
- The submission identifies and demonstrates one or more meaningful middleware capabilities selected, adapted, combined, or designed by the team.
- The middleware executes in a backend, Runtime, data, or infrastructure path rather than only in the UI.
- The repository and documentation are sufficient for reviewers to understand and reproduce the POC.
- `npm run check` passes.
- No secret appears in source, Git history, logs, traces, screenshots, browser storage, or demo output.

Optional evidence: a delegated permission is scoped or revocable, enforced outside the UI, and demonstrated · **an end-to-end Agent Run produces a correlated trace with relevant model, tool, sandbox, policy, or infrastructure events** · a defined threat is blocked or contained, the protected asset remains unchanged, and cleanup or recovery is demonstrated · a team-defined lifecycle, reliability, memory, budget, provider, or coordination capability works as described.

### 1.11 Evaluation criteria

| Category | Weight | What reviewers will look for |
|---|---|---|
| End-to-end middleware behavior | 40 % | A real frontend-to-backend, Runtime, data, or infrastructure path with convincing functional evidence |
| Technical design and integration | 25 % | A clear rationale, coherent architecture, appropriate boundary, focused changes, and extensible contracts |
| Verification and robustness | 20 % | Automated tests, error handling, cleanup or recovery, redaction, and protection against obvious bypasses |
| Demo and reproducibility | 15 % | A concise live demo, useful README, one-command startup, documented limitations, and no hidden manual setup |

### 1.12 Scope guidance and FAQ

This is a hackathon-scale Agent infrastructure challenge, not a requirement to build a complete commercial cloud product. A strong submission may support one local Runtime path, a small mock resource set, and a focused middleware story. Depth, coherence, and relevance matter more than the number of example features implemented. Teams are not required to train a foundation model, build a workflow editor, implement production OAuth, create a general-purpose sandbox, support multiple cloud regions, or deploy to ECS. Mock external services are acceptable, but static UI mockups cannot replace functional middleware behavior.

- **Do we need BytePlus ECS?** No. Local Docker, Colima, or Podman is the default judging path.
- **Do we have to select one recommended example?** No. Teams may adapt, combine, simplify, replace, or invent.
- **Can we use mock users or resources?** Yes. Controlled fixtures are encouraged when they make middleware behavior reproducible.
- **Does a polished UI count as middleware?** No. The behavior must execute in a trusted backend, Runtime, data, or infrastructure path.
- **Why does Ark return 401?** Using an account AK/SK instead of an Ark model API key, or the wrong endpoint ID.
- **Where to start reading the code?** `apps/server/src/types.ts`, `apps/server/src/app.ts`, `apps/server/src/agent-service.ts`, the two `AgentRunner` implementations; then `apps/web/src/App.tsx` for the smallest UI integration point.

## 2. How Oculith maps to this statement

| Track requirement | Where Oculith addresses it |
|---|---|
| Agent-specific problem + coherent middleware story | PRD §1–§2: observability-first reliability middleware (Instrument → Observe → Audit → Verify); `docs/ARCHITECTURE.md` |
| Real behavior in a backend / Runtime / data path | Emitters at the Fastify boundary, `AgentService`, `AgentRunner`, the Codex stream and the workspace; NDJSON trace store; query/audit/eval services (`docs/ARCHITECTURE.md`) |
| Define the boundary and what happens when it fails | PRD §7, §9; invariants (`.claude/rules/glassbox-invariants.md`): telemetry non-blocking, `telemetry.degraded`, fail-closed redaction |
| Trace / audit / observability example | Stable IDs and actor types (PRD §8), span categories, redacted summaries under `safe_summary`, usage/cost signals (metrics), Runs list + trace tree/timeline + first failing step (UX-01/02), export and events query API |
| Normal case + failure / denial / degraded / recovery case | Demo script PRD §13: real Run, controlled timeout fixture, denial evidence, restart interruption, recovered tool failures; UAT rounds in `docs/UAT_COVERAGE.md` |
| Automated verification of the middleware | `npm run check` (unit, guard self-test, build) and the E2E lane (`scripts/e2e/`, 180 checks on the last green run, incl. privacy sweep and performance bounds) |
| Keep secrets out | Redaction before persistence (PRD G4, AC-03), privacy sweep across files/API/export/log/DOM, commit hook secret scan |
| Smallest useful infrastructure | Local POC (`npm run poc`) is the judged path; no Collector/DB/cloud dependency (PRD Appendix A) |
| Lifecycle: open middleware evidence for a Run; update configuration and show what changed | Trace per Run; `configHash` + `configSnapshot` (FR-12); Regression Case → EvalRun → comparison with `REGRESSION` (FR-16…19) |
| Layered architecture with extensible contracts | Observation contract versioned and additive; `TraceStore` interface; adapters never import UI (G6); OTLP mapping adapter |
| Three-minute demo, one-page diagram, README | `docs/demo/` (script + run sheet), `docs/assets/architecture.svg`, `README.md` |
| Evaluation weights (40/25/20/15) | PRD §15 rubric alignment |
