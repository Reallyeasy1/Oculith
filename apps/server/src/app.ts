import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import { configHash, configSnapshot, type AgentService } from "./agent-service.js";
import { createTraceContext, type TraceContext } from "./glassbox/context.js";
import { redactText } from "./glassbox/redact.js";
import type { ObservationEmitter } from "./glassbox/emitter.js";
import type { EvaluationStore } from "./glassbox/evaluation.js";
import type { EvaluationJobWorker } from "./glassbox/jobs.js";
import { MetricStore, metricQueryBody } from "./glassbox/metrics.js";
import { ReliabilityService, reliabilityCompareQuerySchema, reliabilityQuerySchema } from "./glassbox/reliability.js";
import { buildTrace, projectAudit, type TraceView } from "./glassbox/query.js";
import { CATEGORIES, SCHEMA_VERSION, STATUSES } from "./glassbox/schema.js";
import type { RunIndexEntry, TraceStore } from "./glassbox/store.js";
import { executionStatusOf, isFresh, rollupRun, summaryFromView, traceStatusOf, type RunSummary, type RunSummaryStore } from "./glassbox/summary.js";
import type { RunLogStore } from "./run-log-store.js";
import { BASELINE_QUERY_LIMIT, buildAgentRunBaseline, estimatedCost } from "./glassbox/baseline.js";
import { caseFromRun, regressionCaseInput } from "./eval/cases.js";
import { EvalRunner } from "./eval/runner.js";
import { compareEvalRuns } from "./eval/compare.js";

declare module "fastify" {
  interface FastifyRequest {
    glassbox?: TraceContext | undefined;
  }
}

const agentIdParams = z.object({ id: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });
const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
  workspace: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/).optional(),
  template: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/).optional(),
  // #253: operator-set post-run verification; the service trims it and treats "" as "clear the command".
  verifyCommand: z.string().max(500).optional(),
});
const updateAgentBody = createAgentBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
  // #256: lineage of a one-click re-run. The Run itself is ordinary (same session thread, current
  // workspace state); the id is only stamped on run.created.attributes so lineage is queryable.
  rerunOf: z.string().uuid().optional(),
});
// #254: cancel-while-queued — both ids are server-issued UUIDs.
const pendingMessageParams = z.object({ id: z.string().uuid(), messageId: z.string().uuid() });
const evalRunBody = z.object({ agentId: z.string().uuid(), caseIds: z.array(z.string().uuid()).min(1).max(20).refine((ids) => new Set(ids).size === ids.length, "caseIds must be unique"), force: z.boolean().optional() });
// A case is always derived from the trace evidence. The UI may only name it or remove an
// automatically proposed assertion; it cannot supply a different prompt or template.
const regressionCaseFromRunBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  assertions: regressionCaseInput.shape.assertions.optional(),
});
// #192: user-defined llm_judge evaluators. The id is a slug of the name, so a changed rubric under
// the same name versions the same definition (FR-20); the store redacts name/rubric before persisting.
const createEvaluatorBody = z.object({
  name: z.string().trim().min(1).max(80),
  rubric: z.string().trim().min(1).max(4_000),
  minScore: z.number().int().min(0).max(100),
  maxScore: z.number().int().min(0).max(100),
  passThreshold: z.number().int().min(0).max(100),
  setsTaskOutcome: z.boolean().optional(),
}).superRefine((value, ctx) => {
  if (value.minScore >= value.maxScore) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["minScore"], message: "minScore must be less than maxScore" });
  if (value.passThreshold < value.minScore || value.passThreshold > value.maxScore) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["passThreshold"], message: "passThreshold must be between minScore and maxScore" });
});
const evaluatorSlug = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);

export async function createApp(
  config: AppConfig,
  service: AgentService,
  glassbox?: { emitter: ObservationEmitter; store: TraceStore; summaries?: RunSummaryStore | undefined; evaluations?: EvaluationStore | undefined; jobs?: EvaluationJobWorker | undefined; logs?: RunLogStore | undefined },
): Promise<FastifyInstance> {
  const tokenPricing = {
    inputPerMillion: config.glassboxPricePerMtokInput,
    cachedInputPerMillion: config.glassboxPricePerMtokCachedInput,
    outputPerMillion: config.glassboxPricePerMtokOutput,
  };
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 1_048_576,
  });
  // Some boundary tests use a deliberately minimal service double; production AgentService exposes
  // this hook so its per-Run pino child shares Fastify's configured redaction and stdout sink.
  (service as AgentService & { setLogger?: (logger: typeof app.log) => void }).setLogger?.(app.log);

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
  });

  // Registered before any route or awaited plugin: an `await app.register(...)` between the routes and
  // this call (the production static handler) left every route on Fastify's default 500 handler.
  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
            ? frameworkStatus
            : 500;
    if (statusCode >= 500) {
      request.log.error(appError);
    }
    return reply.code(statusCode).send({
      error: appError.message,
      ...(validationError ? { details: error.issues } : {}),
    });
  });

  app.addHook("onRequest", async (request, reply) => {
    if (
      !config.authToken ||
      !request.url.startsWith("/api/") ||
      request.url === "/api/health" ||
      request.url === "/api/auth"
    ) {
      return;
    }
    const header = request.headers.authorization ?? "";
    const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expectedBuffer = Buffer.from(config.authToken);
    const candidateBuffer = Buffer.from(candidate);
    const valid =
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer);
    if (!valid) {
      return reply.code(401).send({ error: "Authentication required" });
    }
  });

  if (glassbox) {
    app.addHook("onRequest", async (request) => {
      if (
        request.method === "POST" &&
        /^\/api\/agents\/[^/]+\/messages$/.test(request.url)
      ) {
        request.glassbox = createTraceContext(
          {
            requestId: request.id,
            method: request.method,
            path: "/api/agents/:id/messages",
          },
          glassbox.emitter.capturePolicy,
        );
      }
    });

    app.addHook("onResponse", async (request, reply) => {
      const ctx = request.glassbox;
      // Only the accepted path has a Run to attach to; a rejected request never opened a trace.
      if (!ctx?.runId || !ctx.agentId) return;
      glassbox.emitter.emit({
        traceId: ctx.traceId,
        spanId: ctx.rootSpanId,
        runId: ctx.runId,
        agentId: ctx.agentId,
        requestId: ctx.requestId,
        actorId: ctx.actorId,
        type: "http.request.completed",
        category: "control",
        phase: "end",
        status: reply.statusCode < 400 ? "ok" : "error",
        name: (ctx.method ?? "POST") + " /api/agents/:id/messages",
        durationMs: Math.max(0, Date.now() - Date.parse(ctx.receivedAt)),
        source: { component: "Fastify", observed: true },
        attributes: { statusCode: reply.statusCode, method: ctx.method ?? "POST" },
      });
    });
  }

  app.get("/api/health", async () => ({
    ok: true,
    service: "volc-agent-launchpad",
  }));

  app.get("/api/auth", async () => ({ required: config.authToken.length > 0 }));

  app.get("/api/system", async () => service.systemInfo());

  app.get("/api/agents", async () => ({ agents: service.listAgents() }));

  app.get("/api/workspaces", async () => ({ workspaces: await service.listWorkspaces() }));
  app.get("/api/workspace-templates", async () => ({ templates: await service.listWorkspaceTemplates() }));

  app.post("/api/agents", async (request, reply) => {
    const body = createAgentBody.parse(request.body);
    const agent = await service.createAgent(body);
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: service.getAgent(id) };
  });

  app.patch("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = updateAgentBody.parse(request.body);
    return { agent: await service.updateAgent(id, body) };
  });

  app.delete("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return service.deleteAgent(id);
  });

  app.post("/api/agents/:id/start", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.startAgent(id) };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.stopAgent(id) };
  });

  app.get("/api/agents/:id/messages", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { messages: service.getMessages(id) };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { runs: service.getRuns(id) };
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = messageBody.parse(request.body);
    const result = await service.sendMessage(id, body.content, request.glassbox,
      body.rerunOf === undefined ? {} : { tags: { rerunOf: body.rerunOf } });
    // #254: a busy Agent queued the message — no Run yet, so nothing to bind the request log to.
    // The client tells the two 202 bodies apart by the `queued: true` discriminator.
    if ("queued" in result) return reply.code(202).send(result);
    request.log = request.log.child({ traceId: result.run.traceId, runId: result.run.id, agentId: id });
    return reply.code(202).send(result);
  });

  // #254: cancel a message that is still waiting in the Agent's queue.
  app.delete("/api/agents/:id/messages/:messageId", async (request, reply) => {
    const { id, messageId } = pendingMessageParams.parse(request.params);
    await service.cancelPendingMessage(id, messageId);
    return reply.code(204).send();
  });

  app.get("/api/runs/:id", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { run: service.getRun(id) };
  });

  app.get("/api/regression-cases", async () => ({ cases: service.listRegressionCases() }));
  app.get("/api/regression-cases/:id", async (request) => ({ regressionCase: service.getRegressionCase(z.object({ id: z.string().uuid() }).parse(request.params).id) }));
  app.delete("/api/regression-cases/:id", async (request, reply) => {
    await service.deleteRegressionCase(z.object({ id: z.string().uuid() }).parse(request.params).id);
    return reply.code(204).send();
  });
  app.post("/api/regression-cases", async (request, reply) => {
    const body = regressionCaseInput.parse(request.body);
    const regressionCase = await service.createRegressionCase({ ...body });
    return reply.code(201).send({ regressionCase });
  });
  app.get("/api/eval-runs", async () => ({ evalRuns: service.listEvalRuns() }));
  app.get("/api/eval-runs/:id", async (request) => ({ evalRun: service.getEvalRun(z.object({ id: z.string().uuid() }).parse(request.params).id) }));
  app.get("/api/eval-runs/:baseline/compare/:candidate", async (request) => {
    const { baseline, candidate } = z.object({ baseline: z.string().uuid(), candidate: z.string().uuid() }).parse(request.params);
    return compareEvalRuns(service.getEvalRun(baseline), service.getEvalRun(candidate));
  });

  if (glassbox) {
    const runsQuery = z.object({ status: z.enum(STATUSES).optional(), agentId: z.string().uuid().optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
    const eventsQuery = z.object({ category: z.string().max(200).optional(), status: z.enum(STATUSES).optional(), q: z.string().max(200).optional() });
    // `entry` lets a caller listing many runs hoist the index lookup out of its loop instead of
    // re-scanning listRuns() per run; omitted, it falls back to the single-run scan.
    const viewFor = async (runId: string, entry?: RunIndexEntry | undefined): Promise<TraceView> => {
      const events = await glassbox.store.readRun(runId);
      const found = entry ?? glassbox.store.listRuns().find((r) => r.runId === runId);
      return buildTrace(events, { capturePolicy: glassbox.emitter.capturePolicy, degraded: glassbox.emitter.isDegraded(runId), truncated: found?.truncated });
    };
    app.post("/api/eval-runs", async (request, reply) => {
      const body = evalRunBody.parse(request.body);
      const agent = service.getAgent(body.agentId);
      body.caseIds.forEach((id) => service.getRegressionCase(id));
      const snapshot = configSnapshot(agent, config);
      const evalRun = await service.createEvalRun({ caseIds: body.caseIds, target: { agentId: agent.id, snapshot, configHash: configHash(snapshot) } }, { force: body.force });
      void new EvalRunner(service, { ...glassbox, pricing: tokenPricing }, config).execute(evalRun.id).catch(async (error) => {
        await service.updateEvalRun(evalRun.id, (item) => { item.status = "failed"; item.completedAt = new Date().toISOString(); item.results.push({ caseId: "", results: [], error: error instanceof Error ? error.message : String(error) }); });
      });
      return reply.code(202).send({ evalRun });
    });
    if (glassbox.summaries && glassbox.evaluations) {
      // FR-23: one bounded query over the two read models; the schema's superRefine turns every contract
      // violation (unknown metric, invalid metric×aggregation pair) into a ZodError → 400 with details.
      const metrics = new MetricStore(glassbox.summaries, glassbox.evaluations);
      app.post("/api/metrics/query", async (request) =>
        ({ capturePolicy: glassbox.emitter.capturePolicy, ...(await metrics.query(metricQueryBody.parse(request.body))) }));
      // #172: historical reliability aggregates — the same window/percentile/rate semantics as the metric
      // catalogue above, shaped for the dashboard: one block per Agent (+ optional configHash and time
      // range), a compare of two configHashes with deltas. Every number carries provenance.
      const reliability = new ReliabilityService(glassbox.summaries, glassbox.evaluations);
      app.get("/api/agents/:id/reliability", async (request) => {
        const { id } = agentIdParams.parse(request.params);
        service.getAgent(id);
        return { capturePolicy: glassbox.emitter.capturePolicy, ...(await reliability.forAgent(id, reliabilityQuerySchema.parse(request.query))) };
      });
      app.get("/api/reliability/compare", async (request) => {
        const query = reliabilityCompareQuerySchema.parse(request.query);
        service.getAgent(query.agentId);
        return { capturePolicy: glassbox.emitter.capturePolicy, ...(await reliability.compare(query)) };
      });
    }
    if (glassbox.jobs) {
      const jobs = glassbox.jobs;
      // #170: historical evaluation runs as a background job — the POST only enqueues (202), progress is
      // polled. Only terminal statuses are selectable; the worker never evaluates a running Run.
      const evaluationJobBody = z.object({
        evaluatorId: z.string().trim().min(1).max(80),
        evaluatorVersion: z.number().int().min(1).optional(),
        filter: z.object({
          agentId: z.string().uuid().optional(),
          // Real configHashes are hex (agent-service.ts); rejecting anything else keeps free text
          // (a pasted secret included) out of the persisted, served job record.
          configHash: z.string().regex(/^[0-9a-f]{1,64}$/i).optional(),
          from: z.string().datetime().optional(),
          to: z.string().datetime().optional(),
          executionStatus: z.enum(["completed", "failed", "timeout", "cancelled"]).optional(),
        }).optional(),
        force: z.boolean().optional(),
        concurrency: z.number().int().min(1).max(2).optional(),
      });
      app.post("/api/evaluation-jobs", async (request, reply) =>
        reply.code(202).send({ job: await jobs.enqueue(evaluationJobBody.parse(request.body)) }));
      app.get("/api/evaluation-jobs", async () => ({ jobs: await jobs.list() }));
      app.get("/api/evaluation-jobs/:id", async (request) =>
        ({ job: await jobs.getOrThrow(runIdParams.parse(request.params).id) }));
      app.post("/api/evaluation-jobs/:id/resume", async (request, reply) =>
        reply.code(202).send({ job: await jobs.resume(runIdParams.parse(request.params).id) }));
    }
    if (glassbox.evaluations) {
      app.get("/api/evaluators", async () => ({ evaluators: await glassbox.evaluations!.listDefinitions() }));
      app.post("/api/evaluators", async (request, reply) => {
        const body = createEvaluatorBody.parse(request.body);
        // Slug the REDACTED name (privacy review of #313): the id reaches disk, the API, the UI and the
        // judge prompt, and slugging (dashes→underscores, lowercasing) would defeat a later pattern scan.
        let safeName: string;
        try { safeName = redactText(body.name).text; }
        catch { throw new HttpError(400, "Evaluator name could not be scanned for secrets"); }
        const id = evaluatorSlug(safeName);
        if (!id) throw new HttpError(400, "Evaluator name must contain letters or digits");
        if (id === "task_completion") throw new HttpError(409, 'Evaluator id "task_completion" is reserved for the seeded judge');
        const existing = await glassbox.evaluations!.getDefinition(id);
        if (existing && existing.type !== "llm_judge") throw new HttpError(409, `Evaluator "${id}" is a ${existing.type} evaluator and cannot become an llm_judge`);
        const evaluator = await glassbox.evaluations!.createDefinition({
          id, name: body.name, type: "llm_judge", rubric: body.rubric,
          minScore: body.minScore, maxScore: body.maxScore, passThreshold: body.passThreshold,
          config: {}, setsTaskOutcome: body.setsTaskOutcome ?? false,
        });
        return reply.code(201).send({ evaluator });
      });
      app.get("/api/runs/:id/evaluations", async (request) => {
        const { id } = runIdParams.parse(request.params);
        service.getRun(id);
        return { evaluations: await glassbox.evaluations!.resultsForRun(id) };
      });
    }
    if (glassbox.summaries) {
      app.get("/api/agents/:id/runs/baseline", async (request) => {
        const { id } = agentIdParams.parse(request.params);
        service.getAgent(id);
        // The builder selects the newest 20 terminal Runs; the bounded query leaves headroom so recent
        // in-progress Runs cannot displace older completed evidence from that window (#213).
        const summaries = await glassbox.summaries!.query({ agentId: id, limit: BASELINE_QUERY_LIMIT });
        return { baseline: buildAgentRunBaseline(summaries, tokenPricing) };
      });
    }
    // Derives the case from the Run's trace evidence; 409 without a template, 400 when the Run cannot be a baseline.
    const draftFor = async (params: unknown) => {
      const run = service.getRun(runIdParams.parse(params).id);
      const template = service.getAgent(run.agentId).workspaceTemplate;
      if (!template) throw new HttpError(409, "This Run did not start from a template-backed workspace");
      try { return caseFromRun(run, await viewFor(run.id), template); }
      catch (error) { throw new HttpError(400, error instanceof Error ? error.message : "Unable to create regression case"); }
    };
    // Prefill is read-only (#158): the dialog edits the draft, then POST below is the single create.
    app.get("/api/runs/:id/regression-case", async (request) => ({ draft: await draftFor(request.params) }));
    app.post("/api/runs/:id/regression-case", async (request, reply) => {
      const requested = regressionCaseFromRunBody.parse(request.body ?? {});
      const input = await draftFor(request.params);
      const regressionCase = await service.createRegressionCase({
        ...input,
        ...(requested.name ? { name: requested.name } : {}),
        ...(requested.assertions ? { assertions: requested.assertions } : {}),
      });
      return reply.code(201).send({ regressionCase });
    });
    app.get("/api/runs", async (request) => {
      const q = runsQuery.parse(request.query);
      const agents = new Map(service.listAgents().map((a) => [a.id, a.name]));
      // One index snapshot per request, not one listRuns() scan per listed run.
      const index = new Map(glassbox.store.listRuns().map((e) => [e.runId, e]));
      // Pre-slice at 2x so the status filter below has spare candidates; with a very selective filter
      // the page can still come back under `limit` even though older matching runs exist.
      const runs = service.allRuns().filter((r) => (!q.agentId || r.agentId === q.agentId) && (!q.from || r.createdAt >= q.from) && (!q.to || r.createdAt <= q.to))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, q.limit * 2);
      // Stored summaries are the read model (#168): one snapshot per request, no NDJSON read for a fresh
      // row. Scoped to the agent filter (#213) — only agentId is safe to push down: the runs above match it
      // exactly, while from/to bound createdAt, not the summaries' startedAt, and a summary missing from
      // this map triggers a stored re-rollup of its Run on every poll. The key is omitted entirely when
      // unfiltered so a backend that distinguishes "present but undefined" cannot misread it as a filter.
      const known = new Map(((await glassbox.summaries?.query(q.agentId ? { agentId: q.agentId } : {})) ?? []).map((s) => [s.runId, s]));
      const rollup = glassbox.summaries ? { traces: glassbox.store, emitter: glassbox.emitter, summaries: glassbox.summaries, pricing: tokenPricing } : undefined;
      const empty = (runId: string): RunSummary => summaryFromView(buildTrace([], { capturePolicy: glassbox.emitter.capturePolicy, degraded: glassbox.emitter.isDegraded(runId) }));
      const items = [];
      for (const run of runs) {
        const entry = index.get(run.id);
        const cached = known.get(run.id);
        // No index entry means no stored events (the empty summary falls through to the record-derived status
        // below). A missing or stale summary of a finished Run is rolled up and stored once; a running Run is
        // rebuilt from its trace on every poll and not stored — its terminal event writes the record.
        const s: RunSummary = !entry ? empty(run.id)
          : isFresh(cached, entry) ? cached
          : rollup && entry.status !== "running" ? (await rollupRun(rollup, run.id, entry)) ?? empty(run.id)
          : summaryFromView(await viewFor(run.id, entry));
        const status = s.eventCount ? traceStatusOf(s.executionStatus) : run.status === "completed" ? "ok" : run.status === "failed" ? "error" : run.status === "cancelled" ? "cancelled" : "running";
        if (q.status && status !== q.status) continue;
        const cost = s.estimatedCostUsd ?? estimatedCost(s, tokenPricing);
        items.push({ runId: run.id, traceId: run.traceId ?? s.traceId, agentId: run.agentId, agentName: agents.get(run.agentId) ?? "", workspace: s.workspace, sessionId: s.sessionId, status, startedAt: s.startedAt ?? run.createdAt, durationMs: s.durationMs, endedReason: s.endedReason, interruptedAfterMs: s.interruptedAfterMs,
          firstFailingStep: s.firstFailingStep, eventCount: s.eventCount, runtime: config.runtimeProvider, model: config.modelProvider === "ark" ? config.arkModel : config.openaiModel || "openai-default",
          usage: s.usage, workspaceChanges: s.workspaceChanges, outcome: s.outcome, capabilities: s.capabilities, toolCalls: s.metrics.toolCalls, toolFailures: s.metrics.toolFailures, toolIdentities: s.metrics.toolIdentities,
          tokens: s.metrics.tokens?.output !== undefined ? { output: s.metrics.tokens.output } : undefined,
          denials: s.denials, actions: s.actions, executionStatus: executionStatusOf(status), taskOutcome: s.taskOutcome, configHash: s.configHash ?? run.configHash, configSnapshot: run.configSnapshot,
          degraded: s.degraded, truncated: s.truncated, evicted: s.evicted, redacted: s.redactedEvents > 0, lastEventAt: s.lastEventAt,
          ...(cost === undefined ? {} : { estimatedCostUsd: cost }) });
        if (items.length >= q.limit) break;
      }
      return { schemaVersion: SCHEMA_VERSION, capturePolicy: glassbox.emitter.capturePolicy, runs: items };
    });
    app.get("/api/runs/:runId/trace", async (request) => { const { runId } = z.object({ runId: z.string().min(1) }).parse(request.params); service.getRun(runId); return viewFor(runId); });
    app.get("/api/runs/:runId/logs", async (request) => {
      const { runId } = z.object({ runId: z.string().min(1) }).parse(request.params);
      service.getRun(runId);
      const query = z.object({ level: z.string().max(20).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(request.query);
      return glassbox.logs ? glassbox.logs.readRun(runId, query) : { lines: [], truncated: false };
    });
    app.get("/api/runs/:runId/audit", async (request) => {
      const { runId } = z.object({ runId: z.string().min(1) }).parse(request.params); service.getRun(runId);
      const view = await viewFor(runId);
      return { schemaVersion: SCHEMA_VERSION, capturePolicy: glassbox.emitter.capturePolicy, audit: projectAudit(view.events) };
    });
    const traceParams = z.object({ traceId: z.string().min(1) });
    const runIdFor = (traceId: string): string => { const runId = glassbox.store.runIdForTrace(traceId); if (!runId) throw new HttpError(404, "Trace not found"); return runId; };
    app.get("/api/traces/:traceId", async (request) => viewFor(runIdFor(traceParams.parse(request.params).traceId)));
    app.get("/api/traces/:traceId/audit", async (request) => {
      const { traceId } = traceParams.parse(request.params); const view = await viewFor(runIdFor(traceId));
      return { schemaVersion: SCHEMA_VERSION, capturePolicy: glassbox.emitter.capturePolicy, audit: projectAudit(view.events) };
    });
    app.get("/api/traces/:traceId/export", async (request, reply) => {
      // FR-12: same builder as the trace route, so the export can never carry anything the API would not.
      const { traceId } = traceParams.parse(request.params); const view = await viewFor(runIdFor(traceId));
      reply.header("content-disposition", `attachment; filename="trace-${traceId.replace(/[^\w.-]/g, "_")}.json"`);
      return { schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), ...view };
    });
    app.get("/api/traces/:traceId/events", async (request) => {
      const { traceId } = traceParams.parse(request.params); const q = eventsQuery.parse(request.query);
      const runId = runIdFor(traceId);
      const categories = q.category === undefined ? undefined : z.array(z.enum(CATEGORIES)).min(1).parse(q.category.split(",").map((value) => value.trim()).filter(Boolean));
      const events = (await glassbox.store.readRun(runId)).filter((e) => (!categories || categories.includes(e.category)) && (!q.status || e.status === q.status) && (!q.q || (e.name + " " + (e.error?.message ?? "")).toLowerCase().includes(q.q.toLowerCase())));
      return { schemaVersion: SCHEMA_VERSION, capturePolicy: glassbox.emitter.capturePolicy, events };
    });
  }

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}
