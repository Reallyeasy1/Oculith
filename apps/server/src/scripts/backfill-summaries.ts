// `npm run glassbox:backfill` — derive a RunSummary for every finished trace on disk that has none or an older
// rollupVersion (#168). Run it while the server is stopped: both processes would otherwise write the same db.json.
import path from "node:path";
import { loadConfig } from "../config.js";
import { ObservationEmitter } from "../glassbox/emitter.js";
import { openSummaryStore } from "../glassbox/postgres-summary.js";
import { openTraceStore } from "../glassbox/postgres-trace.js";
import { backfillSummaries } from "../glassbox/summary.js";
import { JsonStore } from "../store.js";

const config = loadConfig();
const log = (message: string, meta: Record<string, unknown>) => console.warn("[glassbox]", message, JSON.stringify(meta));
const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
await store.initialize();
const traces = await openTraceStore(config, log);
const emitter = new ObservationEmitter({ store: traces, capturePolicy: config.glassboxCapturePolicy, log });
const summaries = await openSummaryStore(config, store);
const report = await backfillSummaries({ traces, emitter, summaries, log, pricing: {
  inputPerMillion: config.glassboxPricePerMtokInput,
  cachedInputPerMillion: config.glassboxPricePerMtokCachedInput,
  outputPerMillion: config.glassboxPricePerMtokOutput,
} });
console.log("[glassbox] backfill", JSON.stringify(report));
await summaries.close?.();
await traces.close?.();
