import { describe, expect, it } from "vitest";
import { ObservationEmitter } from "./emitter.js";
import { OtelTraceAdapter } from "./otel-adapter.js";
import { MemoryTraceStore } from "./store.js";

describe("OtelTraceAdapter", () => {
  it("maps stored spans without copying content-bearing fields", async () => {
    const store = new MemoryTraceStore();
    await store.initialize();
    const emitter = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const root = emitter.startSpan({
      traceId: "trc_12345678", runId: "run-1", agentId: "agent-1", spanId: "spn_root1234",
      type: "run.started", category: "control", name: "run", source: { component: "AgentService", observed: true },
    });
    const model = emitter.startSpan({
      traceId: "trc_12345678", runId: "run-1", agentId: "agent-1", spanId: "spn_model123",
      parentSpanId: root.spanId, type: "model.request", category: "model", name: "model call",
      source: { component: "CodexStreamObserver", observed: true }, attributes: { prompt: "SECRET-PROMPT" },
    });
    model.end("ok", { type: "model.completed", summary: { text: "SECRET-OUTPUT", policy: "safe_summary" } });
    root.end("ok", { type: "run.completed" });
    await emitter.flush();

    const records = await new OtelTraceAdapter(store, "metadata_only").readRun("run-1");
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({
      traceId: "trc_12345678", parentSpanId: root.spanId, status: "OK",
      attributes: { "gen_ai.operation.name": "chat", "glassbox.capture_policy": "metadata_only" },
    });
    expect(JSON.stringify(records)).not.toContain("SECRET");
  });

  it("returns no synthetic spans for an unknown Run", async () => {
    const store = new MemoryTraceStore();
    await store.initialize();
    expect(await new OtelTraceAdapter(store, "metadata_only").readRun("missing")).toEqual([]);
  });
});
