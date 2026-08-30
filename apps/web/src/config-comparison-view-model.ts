import type { AgentConfigSnapshot, EvalRun, ReliabilityBlock, ReliabilityCompareReport, RunListItem } from "./types";
import { formatAverage, formatPercent, taskCompletionDetail } from "./reliability-view-model";
import { formatCount } from "./runs-view-model";

export interface ConfigOption {
  configHash: string;
  snapshot: AgentConfigSnapshot;
  lastSeen: string;
  runs: number;
}

export interface ConfigDiffRow { label: string; a: string; b: string; changed: boolean }
export interface ComparisonRow { key: string; label: string; kind: "telemetry" | "evaluation"; a: string; b: string; delta: string; aDetail?: string; bDetail?: string }
export interface EvalComparisonPair { baselineId: string; candidateId: string }

export function configOptions(runs: readonly RunListItem[]): ConfigOption[] {
  const options = new Map<string, ConfigOption>();
  for (const run of runs) {
    if (!run.configHash || !run.configSnapshot) continue;
    const existing = options.get(run.configHash);
    if (!existing) {
      options.set(run.configHash, { configHash: run.configHash, snapshot: run.configSnapshot, lastSeen: run.startedAt ?? "", runs: 1 });
      continue;
    }
    existing.runs += 1;
    if ((run.startedAt ?? "") > existing.lastSeen) {
      existing.lastSeen = run.startedAt ?? "";
      existing.snapshot = run.configSnapshot;
    }
  }
  return [...options.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

const shown = (value: string | number | undefined): string => value === undefined || value === "" ? "—" : String(value);

export function configDiffRows(a: AgentConfigSnapshot, b: AgentConfigSnapshot): ConfigDiffRow[] {
  const values: [string, string | number | undefined, string | number | undefined][] = [
    ["Instructions hash", a.instructions, b.instructions],
    ["Model", `${a.modelProvider} · ${a.model}`, `${b.modelProvider} · ${b.model}`],
    ["Sandbox", a.codexSandboxMode, b.codexSandboxMode],
    ["Runtime", a.runtimeProvider, b.runtimeProvider],
    ["Runtime image", a.containerRuntimeImage, b.containerRuntimeImage],
    ["CPU limit", a.containerCpuLimit, b.containerCpuLimit],
    ["Memory limit", a.containerMemoryLimit, b.containerMemoryLimit],
    ["PID limit", a.containerPidsLimit, b.containerPidsLimit],
    ["Capture policy", a.capturePolicy, b.capturePolicy],
    ["Verify command hash", a.verifyCommand, b.verifyCommand],
  ];
  return values.map(([label, left, right]) => ({ label, a: shown(left), b: shown(right), changed: left !== right }));
}

const signed = (value: number | null, render: (absolute: number) => string): string => {
  if (value === null) return "—";
  if (value === 0) return render(0);
  return (value > 0 ? "+" : "−") + render(Math.abs(value));
};
const percentagePoints = (value: number | null): string => signed(value, (absolute) => `${Math.round(absolute * 1000) / 10} pp`);
const milliseconds = (value: number | null): string => signed(value, (absolute) => `${Math.round(absolute)} ms`);
const amount = (value: number | null): string => signed(value, (absolute) => formatAverage(absolute));
const count = (value: number | null): string => signed(value, (absolute) => formatCount(Math.round(absolute)));
const successRate = (failureRate: number | null): number | null => failureRate === null ? null : 1 - failureRate;

export function comparisonRows(report: ReliabilityCompareReport): ComparisonRow[] {
  const { a, b, deltas } = report;
  return [
    { key: "runs", label: "Runs", kind: "telemetry", a: String(a.runs), b: String(b.runs), delta: count(deltas.runs) },
    { key: "executionCompletion", label: "Execution completion", kind: "telemetry", a: formatPercent(a.executionCompletionRate), b: formatPercent(b.executionCompletionRate), delta: percentagePoints(deltas.executionCompletionRate) },
    { key: "taskCompletion", label: "Task completion", kind: "evaluation", a: formatPercent(a.taskCompletionRate.rate), b: formatPercent(b.taskCompletionRate.rate), delta: percentagePoints(deltas.taskCompletionRate), aDetail: taskCompletionDetail(a.taskCompletionRate, a.runs), bDetail: taskCompletionDetail(b.taskCompletionRate, b.runs) },
    { key: "toolSuccess", label: "Tool success", kind: "telemetry", a: formatPercent(successRate(a.toolFailureRate)), b: formatPercent(successRate(b.toolFailureRate)), delta: percentagePoints(deltas.toolFailureRate === null ? null : -deltas.toolFailureRate) },
    { key: "avgToolCalls", label: "Average tool calls", kind: "telemetry", a: formatAverage(a.avgToolCalls), b: formatAverage(b.avgToolCalls), delta: amount(deltas.avgToolCalls) },
    { key: "avgInputTokens", label: "Average input tokens", kind: "telemetry", a: formatCount(a.tokens.avgInput === null ? undefined : Math.round(a.tokens.avgInput)), b: formatCount(b.tokens.avgInput === null ? undefined : Math.round(b.tokens.avgInput)), delta: count(deltas.tokens.avgInput) },
    { key: "avgOutputTokens", label: "Average output tokens", kind: "telemetry", a: formatCount(a.tokens.avgOutput === null ? undefined : Math.round(a.tokens.avgOutput)), b: formatCount(b.tokens.avgOutput === null ? undefined : Math.round(b.tokens.avgOutput)), delta: count(deltas.tokens.avgOutput) },
    { key: "latencyP50", label: "Latency p50", kind: "telemetry", a: a.latency.p50 === null ? "—" : `${Math.round(a.latency.p50)} ms`, b: b.latency.p50 === null ? "—" : `${Math.round(b.latency.p50)} ms`, delta: milliseconds(deltas.latency.p50) },
    { key: "latencyP95", label: "Latency p95", kind: "telemetry", a: a.latency.p95 === null ? "—" : `${Math.round(a.latency.p95)} ms`, b: b.latency.p95 === null ? "—" : `${Math.round(b.latency.p95)} ms`, delta: milliseconds(deltas.latency.p95) },
    { key: "denials", label: "Runs with denials", kind: "telemetry", a: formatPercent(a.denialRate), b: formatPercent(b.denialRate), delta: percentagePoints(deltas.denialRate) },
  ];
}

export function provenanceRunIds(...blocks: ReliabilityBlock[]): string[] | undefined {
  if (blocks.some((block) => block.provenance.runIds === undefined)) return undefined;
  return [...new Set(blocks.flatMap((block) => block.provenance.runIds ?? []))];
}

const caseSet = (run: EvalRun): string => [...run.caseIds].sort().join("\u0000");

export function findCompatibleEvalPair(evalRuns: readonly EvalRun[], agentId: string, a: string, b: string): EvalComparisonPair | undefined {
  const completed = evalRuns.filter((run) => run.status === "completed" && run.target.agentId === agentId);
  const baselines = completed.filter((run) => run.target.configHash === a).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const candidates = completed.filter((run) => run.target.configHash === b).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  for (const baseline of baselines) {
    const candidate = candidates.find((run) => caseSet(run) === caseSet(baseline));
    if (candidate) return { baselineId: baseline.id, candidateId: candidate.id };
  }
  return undefined;
}

/** #217: the visible cell ("PASS 0") names neither side nor case — screen readers get both. */
export function evidenceButtonLabel(side: "baseline" | "candidate", caseId: string, pass: boolean): string {
  return `Open ${side} evidence for case ${caseId.slice(0, 8)} — ${pass ? "PASS" : "FAIL"}`;
}

export function comparisonWindow(from: string, to: string): { from?: string; to?: string } {
  return {
    ...(from ? { from: `${from}T00:00:00.000Z` } : {}),
    ...(to ? { to: `${to}T23:59:59.999Z` } : {}),
  };
}
