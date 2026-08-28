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
import type { ObservationEmitter } from "./glassbox/emitter.js";
import { buildTrace, projectAudit, type TraceView } from "./glassbox/query.js";
import { CATEGORIES, SCHEMA_VERSION, STATUSES } from "./glassbox/schema.js";
import type { RunIndexEntry, TraceStore } from "./glassbox/store.js";
import { executionStatusOf, isFresh, rollupRun, summaryFromView, traceStatusOf, type RunSummary, type RunSummaryStore } from "./glassbox/summary.js";
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
});
const updateAgentBody = createAgentBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
});
const evalRunBody = z.object({ agentId: z.string().uuid(), caseIds: z.array(z.string().uuid()).min(1).max(20).refine((ids) => new Set(ids).size === ids.length, "caseIds must be unique"), force: z.boolean().optional() });
// A case is always derived from the trace evidence. The UI may only name it or remove an
// automatically proposed assertion; it cannot supply a different prompt or template.
const regressionCaseFromRunBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  assertions: regressionCaseInput.shape.assertions.optional(),
});

export async function createApp(
  config: AppConfig,
  service: AgentService,
  glassbox?: { emitter: ObservationEmitter; store: TraceStore; summaries?: RunSummaryStore | undefined },
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 1_048_576,
  });

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
    const result = await service.sendMessage(id, body.content, request.glassbox);
    return reply.code(202).send(result);
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
      void new EvalRunner(service, glassbox).execute(evalRun.id).catch(async (error) => {
        await service.updateEvalRun(evalRun.id, (item) => { item.status = "failed"; item.completedAt = new Date().toISOString(); item.results.push({ caseId: "", results: [], error: error instanceof Error ? error.message : String(error) }); });
      });
      return reply.code(202).send({ evalRun });
    });
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
      // Stored summaries are the read model (#168): one snapshot per request, no NDJSON read for a fresh row.
      const known = new Map(((await glassbox.summaries?.query()) ?? []).map((s) => [s.runId, s]));
      const rollup = glassbox.summaries ? { traces: glassbox.store, emitter: glassbox.emitter, summaries: glassbox.summaries } : undefined;
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
        items.push({ runId: run.id, traceId: run.traceId ?? s.traceId, agentId: run.agentId, agentName: agents.get(run.agentId) ?? "", workspace: s.workspace, status, startedAt: s.startedAt ?? run.createdAt, durationMs: s.durationMs, endedReason: s.endedReason, interruptedAfterMs: s.interruptedAfterMs,
          firstFailingStep: s.firstFailingStep, eventCount: s.eventCount, runtime: config.runtimeProvider, model: config.modelProvider === "ark" ? config.arkModel : config.openaiModel || "openai-default",
          usage: s.usage, workspaceChanges: s.workspaceChanges, outcome: s.outcome, capabilities: s.capabilities, toolCalls: s.metrics.toolCalls, toolFailures: s.metrics.toolFailures, toolIdentities: s.metrics.toolIdentities,
          tokens: s.metrics.tokens?.output !== undefined ? { output: s.metrics.tokens.output } : undefined,
          denials: s.denials, actions: s.actions, executionStatus: executionStatusOf(status), taskOutcome: s.taskOutcome, configHash: s.configHash ?? run.configHash, configSnapshot: run.configSnapshot,
          degraded: s.degraded, truncated: s.truncated, evicted: s.evicted, redacted: s.redactedEvents > 0, lastEventAt: s.lastEventAt });
        if (items.length >= q.limit) break;
      }
      return { schemaVersion: SCHEMA_VERSION, capturePolicy: glassbox.emitter.capturePolicy, runs: items };
    });
    app.get("/api/runs/:runId/trace", async (request) => { const { runId } = z.object({ runId: z.string().min(1) }).parse(request.params); service.getRun(runId); return viewFor(runId); });
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
