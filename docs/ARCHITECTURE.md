# Architecture

Volc Agent Launchpad is a single-node control plane. GlassBox observes the existing execution path; it does not replace the runner or become a second source of Run state.

## Implemented system

```mermaid
flowchart LR
  subgraph browser["Experience boundary · browser"]
    Web["React UI<br/>apps/web/src/App.tsx<br/>RunsView.tsx · TraceDetail.tsx"]
  end

  subgraph control["Control plane · host / ECS task"]
    API["Fastify routes<br/>apps/server/src/app.ts"]
    Service["AgentService<br/>agent-service.ts"]
    Json["JsonStore<br/>store.ts"]
    Workspaces["WorkspaceManager<br/>workspace.ts"]

    subgraph glassbox["GlassBox instrumentation boundary"]
      Context["request / Run context<br/>glassbox/context.ts"]
      Adapter["service + runner adapters<br/>agent-service.ts<br/>codex-runner.ts<br/>container-codex-runner.ts"]
      Observer["CodexStreamObserver<br/>glassbox/codex-observer.ts"]
      Emitter["ObservationEmitter<br/>glassbox/emitter.ts"]
      Redact["REDACTION POINT<br/>glassbox/redact.ts"]
      EventStore["NDJSON TraceStore + index<br/>glassbox/store.ts"]
      Query["buildTrace / projectAudit<br/>glassbox/query.ts"]
      Projections["Trace · Audit · Metrics<br/>API projections"]
      Denial["FAILURE / DENIAL EVIDENCE<br/>runner outcome · policy.denied"]
    end

    subgraph eval["Regression path"]
      Cases["RegressionCase<br/>eval/cases.ts"]
      EvalRunner["EvalRunner<br/>eval/runner.ts"]
      Evaluators["evaluators<br/>eval/evaluators.ts"]
      Compare["compareEvalRuns<br/>eval/compare.ts"]
      EvalRecord["EvalRun record<br/>store.ts"]
    end
  end

  subgraph runtime["Agent Runtime trust boundary · disposable container or ECS process"]
    Runner["CodexRunner / ContainerCodexRunner"]
    Codex["Codex CLI"]
    Model["Ark / OpenAI model API"]
    Workspace["Agent workspace"]
  end

  Controller["Future controller / policy engine<br/>NOT BUILT"]

  Web -->|Bearer-authenticated /api/*| API
  API --> Service
  Service --> Json
  Service --> Workspaces
  Service -->|AgentRunner.run| Runner
  Runner --> Codex --> Model
  Runner --> Workspace

  API --> Context --> Adapter
  Service --> Adapter
  Runner --> Observer --> Adapter
  Adapter -->|ObservationEvent| Emitter --> Redact --> EventStore
  EventStore --> Query --> Projections --> API
  Runner -->|exit / timeout / cancel| Denial
  Observer -->|declined command| Denial --> Emitter

  Cases --> EvalRunner -->|isolated Run via AgentService| Service
  EventStore --> Evaluators --> EvalRecord --> Compare
  EvalRunner --> Evaluators
  EvalRecord --> Json

  Controller -. future rulings .-> Denial
  Controller -. future actions .-> Service

  classDef trust fill:#eef5ff,stroke:#2563eb,stroke-width:2px;
  classDef privacy fill:#ecfdf5,stroke:#059669,stroke-width:2px;
  classDef failure fill:#fff7ed,stroke:#ea580c,stroke-width:2px;
  classDef future fill:#f8fafc,stroke:#64748b,stroke-dasharray:5 5;
  class browser,runtime trust;
  class Redact privacy;
  class Denial failure;
  class Controller future;
```

[PNG export of the architecture diagram](assets/architecture.png)

The browser, control plane, and Agent Runtime are separate trust boundaries. The API token protects the demo endpoint but is not user identity or authorization. The runtime boundary limits ordinary execution; it is not hardened multi-tenant isolation. Secrets and content cross into telemetry only through `redactEvent`, before the NDJSON append. Failures and sandbox denials remain observations: they do not grant GlassBox control over execution.

## Contract

`apps/server/src/glassbox/schema.ts` is the authoritative event contract. Every `ObservationEvent` carries bounded correlation identifiers (`traceId`, `spanId`, `runId`, `agentId`), actor and source attribution, sequence and timing, category/type/status, bounded attributes, optional safe summary/error, and privacy metadata. `schemaVersion` is `1.0`; additive event types do not invalidate stored 1.0 events.

The behavioral rules are maintained in [GlassBox invariants](../.claude/rules/glassbox-invariants.md). In particular, telemetry must never break baseline Agent behavior, fabricate evidence, leak credentials, or confuse absence with unavailability.

## Persisted and derived data

| Persisted | Derived at read time |
| --- | --- |
| Agent, message, Run, regression case and EvalRun records in `data/launchpad.json` (`JsonStore`) | Span trees, durations, first actionable failure and capability state (`buildTrace`) |
| Redacted, bounded `ObservationEvent` lines in `data/traces/<runId>.ndjson` | Trace, Audit and Metrics projections |
| Bounded trace index entries in `data/traces/index.json` | Workspace change totals, token/tool metrics and comparison presentation |
| Agent workspaces below `workspaces/` and archived deletions below `workspaces/.deleted/` | Eval verdicts produced by deterministic evaluators from stored Run evidence |
| Codex configuration and resumable sessions below `codex-home/` | UI filters, attention counts and dashboard summaries |

`JsonStore` serializes writes and atomically replaces one JSON file. `TraceStore` appends one redacted NDJSON stream per Run and maintains a bounded index. Both are single-process POC stores.

## Execution profiles

| Profile | Control plane | Agent execution |
| --- | --- | --- |
| Local POC | Host Node.js | Disposable Docker, Colima, or Podman container per turn |
| ECS | Application container | Codex child process in the same task |
| Local development | Host Node.js | Host Codex process |

Both runner adapters use argv-only process execution, bounded output/time, resumable Codex threads, and escalating termination. The same `AgentService` Run path is used by interactive and isolated regression execution.

## Intentionally not built

- No autonomous controller, approval engine, or policy-enforcement loop; the dashed controller boundary is an extension seam only.
- No multi-user identity, authorization, hardened tenant isolation, or distributed control plane.
- No external trace database or message bus; JSON and NDJSON are deliberate POC storage choices.
- No LLM-based evaluator or success inference. Regression evaluators use explicit stored evidence.
- No deployment topology beyond the local POC and single ECS task described above.
