import { describe, expect, it } from "vitest";
import type { AgentConfigSnapshot, EvalRun, ReliabilityCompareReport, RunListItem } from "./types";
import { comparisonRows, configDiffRows, configOptions, evidenceButtonLabel, findCompatibleEvalPair, provenanceRunIds } from "./config-comparison-view-model";

const snapshot = (overrides: Partial<AgentConfigSnapshot> = {}): AgentConfigSnapshot => ({
  instructions: "sha256:instructions-a",
  modelProvider: "ark",
  model: "deepseek-v4-pro-260425",
  codexSandboxMode: "workspace-write",
  runtimeProvider: "container",
  containerRuntimeImage: "volc-agent-runtime:local",
  containerCpuLimit: 2,
  containerMemoryLimit: "2g",
  containerPidsLimit: 256,
  capturePolicy: "metadata_only",
  ...overrides,
});

const run = (runId: string, configHash: string, startedAt: string, configSnapshot = snapshot()): RunListItem => ({
  runId, configHash, configSnapshot, startedAt, traceId: "trace-" + runId, agentId: "agent-1", agentName: "Agent",
  status: "ok", eventCount: 1, runtime: "container", model: "ark", capabilities: { model: "observed", tool: "observed" },
  toolCalls: 1, toolFailures: 0, denials: 0, actions: 0, executionStatus: "completed", taskOutcome: "passed",
  degraded: false, truncated: false, evicted: false, redacted: false,
});

describe("configOptions (#174)", () => {
  it("deduplicates config hashes, keeps the latest snapshot, and orders newest first", () => {
    expect(configOptions([
      run("old-a", "cfg-a", "2026-08-01T00:00:00.000Z"),
      run("b", "cfg-b", "2026-08-03T00:00:00.000Z", snapshot({ model: "candidate" })),
      run("new-a", "cfg-a", "2026-08-02T00:00:00.000Z", snapshot({ model: "base-latest" })),
    ])).toEqual([
      expect.objectContaining({ configHash: "cfg-b", runs: 1, snapshot: expect.objectContaining({ model: "candidate" }) }),
      expect.objectContaining({ configHash: "cfg-a", runs: 2, snapshot: expect.objectContaining({ model: "base-latest" }) }),
    ]);
  });
});

describe("configSnapshot diff (#174)", () => {
  it("shows hashed instructions, model, and container limits without exposing raw instructions", () => {
    const rows = configDiffRows(snapshot(), snapshot({
      instructions: "sha256:instructions-b",
      model: "candidate",
      containerCpuLimit: 4,
      containerMemoryLimit: "4g",
      containerPidsLimit: 512,
    }));
    expect(rows.filter((row) => row.changed).map((row) => row.label)).toEqual([
      "Instructions hash", "Model", "CPU limit", "Memory limit", "PID limit",
    ]);
    expect(JSON.stringify(rows)).not.toContain("raw instructions");
  });
});

describe("historical reliability comparison rows (#174)", () => {
  it("keeps telemetry and evaluation distinct and renders raw b-minus-a deltas", () => {
    const report = {
      schemaVersion: "1.0", capturePolicy: "metadata_only", agentId: "agent-1",
      a: { configHash: "cfg-a", runs: 2, executionCompletionRate: 1, taskCompletionRate: { evaluatorId: "task_completion", version: 1, evaluated: 2, passed: 2, rate: 1 }, toolFailureRate: 0.25, avgToolCalls: 4, tokens: { avgInput: 100, avgOutput: 20, sum: 240, sampled: 2 }, latency: { p50: 1000, p95: 2000, sampled: 2 }, denialRate: 0.5, series: [], provenance: { count: 2, runIds: ["a1", "a2"], filter: { agentId: "agent-1", configHash: "cfg-a" } } },
      b: { configHash: "cfg-b", runs: 2, executionCompletionRate: 0.5, taskCompletionRate: { evaluatorId: "task_completion", version: 1, evaluated: 2, passed: 1, rate: 0.5 }, toolFailureRate: 0, avgToolCalls: 6, tokens: { avgInput: 120, avgOutput: 30, sum: 300, sampled: 2 }, latency: { p50: 800, p95: 1500, sampled: 2 }, denialRate: 0, series: [], provenance: { count: 2, runIds: ["b1", "b2"], filter: { agentId: "agent-1", configHash: "cfg-b" } } },
      deltas: { runs: 0, executionCompletionRate: -0.5, taskCompletionRate: -0.5, toolFailureRate: -0.25, avgToolCalls: 2, tokens: { avgInput: 20, avgOutput: 10, sum: 60 }, latency: { p50: -200, p95: -500 }, denialRate: -0.5 },
    } satisfies ReliabilityCompareReport;
    const rows = comparisonRows(report);
    expect(rows.find((row) => row.key === "taskCompletion")).toMatchObject({ kind: "evaluation", a: "100%", b: "50%", delta: "−50 pp" });
    expect(rows.find((row) => row.key === "toolSuccess")).toMatchObject({ kind: "telemetry", a: "75%", b: "100%", delta: "+25 pp" });
    expect(rows.find((row) => row.key === "latencyP95")).toMatchObject({ delta: "−500 ms" });
    expect(JSON.stringify(rows)).not.toMatch(/REGRESSION|improved|degraded/i);
    expect(provenanceRunIds(report.a, report.b)).toEqual(["a1", "a2", "b1", "b2"]);
  });
});

describe("deterministic comparison link (#174)", () => {
  const evalRun = (id: string, configHash: string, caseIds: string[], createdAt: string): EvalRun => ({
    id, caseIds, target: { agentId: "agent-1", configHash, snapshot: snapshot() }, runIds: [], results: [], status: "completed", createdAt,
  });
  it("links only a completed pair for the same Agent and case set", () => {
    const pair = findCompatibleEvalPair([
      evalRun("base", "cfg-a", ["case-1"], "2026-08-01T00:00:00.000Z"),
      evalRun("wrong-cases", "cfg-b", ["case-2"], "2026-08-03T00:00:00.000Z"),
      evalRun("candidate", "cfg-b", ["case-1"], "2026-08-02T00:00:00.000Z"),
    ], "agent-1", "cfg-a", "cfg-b");
    expect(pair).toEqual({ baselineId: "base", candidateId: "candidate" });
    expect(findCompatibleEvalPair([evalRun("other", "cfg-a", ["case-1"], "2026-08-01T00:00:00.000Z")], "agent-1", "cfg-a", "cfg-b")).toBeUndefined();
  });
});

describe("evidence button accessible name (#217)", () => {
  it("names side, case, and verdict instead of the bare cell text", () => {
    expect(evidenceButtonLabel("baseline", "0f8b1c2d-aaaa-bbbb-cccc-000000000000", true)).toBe("Open baseline evidence for case 0f8b1c2d — PASS");
    expect(evidenceButtonLabel("candidate", "0f8b1c2d-aaaa-bbbb-cccc-000000000000", false)).toBe("Open candidate evidence for case 0f8b1c2d — FAIL");
  });
});
