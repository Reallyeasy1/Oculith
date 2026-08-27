import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { ObservationEmitter } from "./glassbox/emitter.js";
import { NdjsonTraceStore } from "./glassbox/store.js";
import { JsonRunSummaryStore, scheduleRollup } from "./glassbox/summary.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot, config.workspaceTemplatesDirectory);

const glassboxLog = (message: string, meta: Record<string, unknown>) =>
  console.warn("[glassbox]", message, JSON.stringify(meta));
const traceStore = new NdjsonTraceStore(config.traceDirectory, glassboxLog);
await traceStore.initialize();
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
const summaries = new JsonRunSummaryStore(store);
const rollup = { traces: traceStore, emitter, summaries, log: glassboxLog };
const service = new AgentService(config, store, workspaces, runner, emitter, (runId) => void scheduleRollup(rollup, runId));
await service.initialize();

const app = await createApp(config, service, { emitter, store: traceStore, summaries });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
