import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { configuredModel, isModelConfigured, loadConfig, writeCodexConfig } from "./config.js";
import { ObservationEmitter } from "./glassbox/emitter.js";
import { JsonEvaluationStore } from "./glassbox/evaluation.js";
import { builtinRunEvaluators, EvaluationJobWorker, JsonEvaluationJobStore } from "./glassbox/jobs.js";
import { ArkTaskCompletionJudge, FakeTaskCompletionJudge, JsonTaskCompletionSource, TaskCompletionEvaluator } from "./glassbox/task-completion.js";
import { openSummaryStore } from "./glassbox/postgres-summary.js";
import { openTraceStore } from "./glassbox/postgres-trace.js";
import { scheduleRollup } from "./glassbox/summary.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";
import { RunLogStore } from "./run-log-store.js";

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
await store.initialize(); // before anything seeds or rolls up into it; AgentService.initialize() re-reads the same file
const workspaces = new WorkspaceManager(config.workspaceRoot, config.workspaceTemplatesDirectory);
const runLogs = new RunLogStore(path.join(config.dataDirectory, "logs"), config.glassboxLogMaxMb * 1024 * 1024);
await runLogs.initialize();

const glassboxLog = (message: string, meta: Record<string, unknown>) =>
  console.warn("[glassbox]", message, JSON.stringify(meta));
// Traces follow GLASSBOX_STORE too (#175 phase B): NDJSON by default, PostgreSQL when opted in.
const traceStore = await openTraceStore(config, glassboxLog);
// Retention (FR-14) runs once per boot, before sequences are seeded so tombstones count. Never silent: one summary
// line always, one line per evicted Run, and a failure here must not stop the server from booting.
try {
  const retention = await traceStore.cleanup({ retentionDays: config.glassboxRetentionDays, maxDiskMb: config.glassboxMaxDiskMb });
  glassboxLog("retention", { retentionDays: config.glassboxRetentionDays, maxDiskMb: config.glassboxMaxDiskMb, runs: retention.runs,
    evicted: retention.evicted.length, bytesBefore: retention.bytesBefore, bytesAfter: retention.bytesAfter, overCap: retention.overCap });
  for (const e of retention.evicted) glassboxLog("retention.evicted", e);
} catch (error) {
  glassboxLog("retention.failed", { error: String(error).slice(0, 200) });
}
const emitter = new ObservationEmitter({
  store: traceStore,
  capturePolicy: config.glassboxCapturePolicy,
  log: glassboxLog,
});
// Resume sequence numbering across a restart so a trace file stays monotonic.
for (const entry of traceStore.listRuns()) emitter.seedSequence(entry.traceId, entry.lastSequence);

const runner = createRunner(config, emitter);
// Per-Run summaries (#168): rolled up after each terminal event, off the Run's path; the list route reads them.
const summaries = await openSummaryStore(config, store);
const evaluations = new JsonEvaluationStore(store, summaries, undefined, configuredModel(config));
await evaluations.initialize();
// Evaluation jobs (#170): background worker over stored summaries; restart honesty first, then the
// loop picks up whatever was queued. The real task-completion judge is Ark-only; the deterministic
// fake is an explicit E2E setting and is never the default.
const taskCompletionJudge = config.taskCompletionJudge === "fake"
  ? new FakeTaskCompletionJudge()
  : config.modelProvider === "ark" && isModelConfigured(config)
    ? new ArkTaskCompletionJudge({ apiKey: config.arkApiKey, baseUrl: config.arkBaseUrl, model: config.arkModel })
    : undefined;
const taskCompletion = taskCompletionJudge
  ? new TaskCompletionEvaluator(new JsonTaskCompletionSource(store, traceStore), taskCompletionJudge)
  : undefined;
const evaluationJobs = new EvaluationJobWorker({ jobs: new JsonEvaluationJobStore(store), summaries, evaluations, evaluators: builtinRunEvaluators(taskCompletion), log: glassboxLog });
await evaluationJobs.initialize();
evaluationJobs.start();
const rollup = { traces: traceStore, emitter, summaries, log: glassboxLog, pricing: {
  inputPerMillion: config.glassboxPricePerMtokInput,
  cachedInputPerMillion: config.glassboxPricePerMtokCachedInput,
  outputPerMillion: config.glassboxPricePerMtokOutput,
} };
// evictRun after the rollup (which reads isDegraded): frees the emitter's per-run bookkeeping (#54).
const service = new AgentService(config, store, workspaces, runner, emitter, (runId, verify) => void scheduleRollup(rollup, runId, verify).then(() => emitter.evictRun(runId)), runLogs);
await service.initialize();
await service.startHeartbeat();

const app = await createApp(config, service, { emitter, store: traceStore, summaries, evaluations, jobs: evaluationJobs, logs: runLogs });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  service.stopHeartbeat();
  evaluationJobs.stop();
  await app.close();
  await summaries.close?.();
  await traceStore.close?.();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
