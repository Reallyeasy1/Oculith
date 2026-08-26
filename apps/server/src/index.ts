import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { ObservationEmitter } from "./glassbox/emitter.js";
import { NdjsonTraceStore } from "./glassbox/store.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);

const traceStore = new NdjsonTraceStore(config.traceDirectory);
await traceStore.initialize();
const emitter = new ObservationEmitter({
  store: traceStore,
  capturePolicy: config.glassboxCapturePolicy,
  log: (message, meta) => console.warn("[glassbox]", message, JSON.stringify(meta)),
});
// Resume sequence numbering across a restart so a trace file stays monotonic.
for (const entry of traceStore.listRuns()) emitter.seedSequence(entry.traceId, entry.lastSequence);

const runner = createRunner(config, emitter);
const service = new AgentService(config, store, workspaces, runner, emitter);
await service.initialize();

const app = await createApp(config, service, { emitter, store: traceStore });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
