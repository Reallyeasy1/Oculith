// `npm run glassbox:backfill` — derive a RunSummary for every finished trace on disk that has none or an older
// rollupVersion (#168). Run it while the server is stopped: both processes would otherwise write the same db.json.
import path from "node:path";
import { loadConfig } from "../config.js";
import { ObservationEmitter } from "../glassbox/emitter.js";
import { NdjsonTraceStore } from "../glassbox/store.js";
import { openSummaryStore } from "../glassbox/postgres-summary.js";
import { backfillSummaries } from "../glassbox/summary.js";
import { JsonStore } from "../store.js";

const config = loadConfig();
const log = (message: string, meta: Record<string, unknown>) => console.warn("[glassbox]", message, JSON.stringify(meta));
const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
await store.initialize();
const traces = new NdjsonTraceStore(config.traceDirectory, log);
await traces.initialize();
const emitter = new ObservationEmitter({ store: traces, capturePolicy: config.glassboxCapturePolicy, log });
const report = await backfillSummaries({ traces, emitter, summaries: await openSummaryStore(config, store), log });
console.log("[glassbox] backfill", JSON.stringify(report));
