import type { Agent, AgentRun, Assertion, AuditRow, CapturePolicy, EvalRun, EvaluationResult, EvaluatorDefinition, Message, QueuedMessageReceipt, RegressionCase, ReliabilityCompareReport, ReliabilityReport, RunListItem, RunLogLine, SystemInfo, TraceView, Workspace, WorkspaceFile, WorkspaceListing, WorkspaceTemplate } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

let authToken = "";

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

// #40: the SSE stream (live.ts) needs the token at connect time — EventSource cannot set headers.
export function getAuthToken(): string {
  return authToken;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed", response.status);
  }
  return data;
}

export const api = {
  auth: () => request<{ required: boolean }>("/api/auth"),
  system: () => request<SystemInfo>("/api/system"),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
    workspace?: string;
    template?: string;
    verifyCommand?: string;
    budget?: import("./types").AgentBudget | null;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string; workspace?: string; verifyCommand?: string; budget?: import("./types").AgentBudget | null },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  listWorkspaces: () => request<{ workspaces: Workspace[] }>("/api/workspaces"),
  browseWorkspace: (id: string, path: string) =>
    request<WorkspaceListing>("/api/agents/" + id + "/workspace?path=" + encodeURIComponent(path)),
  readWorkspaceFile: (id: string, path: string) =>
    request<WorkspaceFile>("/api/agents/" + id + "/workspace/file?path=" + encodeURIComponent(path)),
  listWorkspaceTemplates: () => request<{ templates: WorkspaceTemplate[] }>("/api/workspace-templates"),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  runBaseline: (id: string) =>
    request<{ baseline: import("./types").AgentRunBaseline }>("/api/agents/" + id + "/runs/baseline"),
  // #255: live budget status for the Agent banner — the rolling 24 h window the pre-run gate enforces.
  agentBudget: (id: string) =>
    request<import("./types").AgentBudgetReport>("/api/agents/" + id + "/budget"),
  // rerunOf (#256): id of the Run this prompt re-dispatches; stamped on run.created for lineage.
  // #254: a busy Agent answers with a QueuedMessageReceipt instead of a started Run.
  sendMessage: (id: string, content: string, rerunOf?: string) =>
    request<{ run: AgentRun; message: Message } | QueuedMessageReceipt>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content, ...(rerunOf ? { rerunOf } : {}) }),
      },
    ),
  // #254: cancel a message still waiting in the Agent's queue.
  cancelPendingMessage: (agentId: string, messageId: string) =>
    request<void>("/api/agents/" + agentId + "/messages/" + messageId, { method: "DELETE" }),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
  listRuns: (options: { agentId?: string; limit?: number } = {}) =>
    request<{ schemaVersion: string; capturePolicy: CapturePolicy; runs: RunListItem[] }>(
      "/api/runs?" + new URLSearchParams({ limit: String(options.limit ?? 100), ...(options.agentId ? { agentId: options.agentId } : {}) }),
    ),
  trace: (runId: string) => request<TraceView>("/api/runs/" + runId + "/trace"),
  listRegressionCases: () => request<{ cases: RegressionCase[] }>("/api/regression-cases"),
  // Read-only prefill (#158): nothing is persisted until saveRunAsRegressionCase.
  regressionCaseDraft: (runId: string) => request<{ draft: { name: string; assertions: Assertion[] } }>("/api/runs/" + runId + "/regression-case"),
  saveRunAsRegressionCase: (runId: string, body: { name: string; assertions: Assertion[] }) =>
    request<{ regressionCase: RegressionCase }>("/api/runs/" + runId + "/regression-case", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteRegressionCase: (id: string) =>
    request<void>("/api/regression-cases/" + id, { method: "DELETE" }),
  listEvalRuns: () => request<{ evalRuns: EvalRun[] }>("/api/eval-runs"),
  evalRun: (id: string) => request<{ evalRun: EvalRun }>("/api/eval-runs/" + id),
  compareEvalRuns: (baselineId: string, candidateId: string) => request<import("./types").EvalComparison>("/api/eval-runs/" + baselineId + "/compare/" + candidateId),
  startEvalRun: (body: { agentId: string; caseIds: string[]; force?: boolean }) =>
    request<{ evalRun: EvalRun }>("/api/eval-runs", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  // #173: historical reliability aggregates for the Agent detail panel (#172's endpoint; server defaults
  // to daily buckets and the seeded task_completion evaluator).
  reliability: (agentId: string) =>
    request<ReliabilityReport>("/api/agents/" + agentId + "/reliability"),
  // #192: the evaluator catalogue and the user-defined llm_judge create form.
  listEvaluators: () => request<{ evaluators: EvaluatorDefinition[] }>("/api/evaluators"),
  createEvaluator: (body: { name: string; rubric: string; minScore: number; maxScore: number; passThreshold: number; setsTaskOutcome?: boolean }) =>
    request<{ evaluator: EvaluatorDefinition }>("/api/evaluators", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  // #174: historical quality deltas for two behavior configurations of one Agent.
  compareReliability: (agentId: string, a: string, b: string, window: { from?: string; to?: string } = {}) =>
    request<ReliabilityCompareReport>("/api/reliability/compare?" + new URLSearchParams({ agentId, a, b, ...window })),
  // #173: stored evaluation results for one Run, shown in the trace detail.
  runEvaluations: (runId: string) =>
    request<{ evaluations: EvaluationResult[] }>("/api/runs/" + runId + "/evaluations"),
  logs: (runId: string, level = "") => request<{ lines: RunLogLine[]; truncated: boolean }>("/api/runs/" + runId + "/logs?" + new URLSearchParams({ limit: "500", ...(level ? { level } : {}) })),
  audit: (runId: string) => request<{ schemaVersion: string; capturePolicy: CapturePolicy; audit: AuditRow[] }>("/api/runs/" + runId + "/audit"),
  exportTrace: async (traceId: string): Promise<{ blob: Blob; filename: string }> => {
    const response = await fetch("/api/traces/" + encodeURIComponent(traceId) + "/export", {
      headers: authToken ? { Authorization: "Bearer " + authToken } : undefined,
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(data.error ?? "Export failed", response.status);
    }
    const disposition = response.headers.get("Content-Disposition") ?? "";
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? "trace-" + traceId + ".json";
    return { blob: await response.blob(), filename };
  },
};
