import type { Agent, AgentRun, Assertion, AuditRow, CapturePolicy, EvalRun, EvaluationResult, EvaluatorDefinition, Message, PreviewCommand, PreviewServability, QueuedMessageReceipt, RegressionCase, ReliabilityCompareReport, ReliabilityReport, RunListItem, RunLogLine, SystemInfo, TraceView, Workspace, WorkspaceFile, WorkspaceListing, WorkspacePreview, WorkspaceTemplate } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

/** #344: server-side zod failures arrive as a stringified issue array in `error`; showing it
 * verbatim puts raw JSON in the banner. Render the FIRST issue as "path: message" (+N more when
 * several); anything that isn't a zod issue array passes through unchanged. */
export function humanizeErrorMessage(message: string): string {
  if (!message.trimStart().startsWith("[")) return message;
  try {
    const issues: unknown = JSON.parse(message);
    if (!Array.isArray(issues) || issues.length === 0) return message;
    const first = issues[0] as { path?: unknown; message?: unknown };
    if (typeof first !== "object" || first === null || typeof first.message !== "string" || !Array.isArray(first.path)) return message;
    const prefix = first.path.length > 0 ? first.path.join(".") + ": " : "";
    const more = issues.length > 1 ? " (+" + (issues.length - 1) + " more)" : "";
    return prefix + first.message + more;
  } catch {
    return message;
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
    throw new ApiError(data.error ? humanizeErrorMessage(data.error) : "Request failed", response.status);
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
  // #66: workspace editing. Uploads travel as base64/utf8 inside JSON; the server enforces the
  // caps (1 MB per PUT file, 20 files / 8 MB per batch), refuses managed files and credential-
  // looking content with 400, and refuses everything with 409 while a Run has the workspace mounted.
  writeWorkspaceFile: (id: string, file: { path: string; content: string; encoding: "utf8" | "base64" }) =>
    request<{ file: { path: string; bytes: number } }>("/api/agents/" + id + "/workspace/file", {
      method: "PUT",
      body: JSON.stringify(file),
    }),
  seedWorkspaceFiles: (id: string, files: { path: string; content: string; encoding: "utf8" | "base64" }[]) =>
    request<{ files: { path: string; bytes: number }[] }>("/api/agents/" + id + "/workspace/files", {
      method: "POST",
      body: JSON.stringify({ files }),
    }),
  deleteWorkspaceFile: (id: string, path: string) =>
    request<{ file: { path: string; bytes: number } }>(
      "/api/agents/" + id + "/workspace/file?path=" + encodeURIComponent(path),
      { method: "DELETE" },
    ),
  resetWorkspace: (id: string, forgetThread: boolean) =>
    request<{ agent: Agent; archivedWorkspace: string }>("/api/agents/" + id + "/workspace/reset", {
      method: "POST",
      body: JSON.stringify({ forgetThread }),
    }),
  listWorkspaceTemplates: () => request<{ templates: WorkspaceTemplate[] }>("/api/workspace-templates"),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  // #96/#335: workspace preview — one hardened container serving the workspace on a loopback
  // port. Available whenever the engine probe passes (any runtime provider); an unavailable
  // engine answers 409. `servable` says which commands would actually serve this workspace.
  preview: (id: string) =>
    request<{ preview: WorkspacePreview | null; servable: PreviewServability }>("/api/agents/" + id + "/preview"),
  startPreview: (id: string, command: PreviewCommand = "static") =>
    request<{ preview: WorkspacePreview }>("/api/agents/" + id + "/preview", {
      method: "POST",
      body: JSON.stringify({ command }),
    }),
  stopPreview: (id: string) =>
    request<{ preview: WorkspacePreview }>("/api/agents/" + id + "/preview", { method: "DELETE" }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  runBaseline: (id: string) =>
    request<{ baseline: import("./types").AgentRunBaseline }>("/api/agents/" + id + "/runs/baseline"),
  // #255: live budget status for the Agent banner — the rolling 24 h window the pre-run gate enforces.
  agentBudget: (id: string) =>
    request<import("./types").AgentBudgetReport>("/api/agents/" + id + "/budget"),
  // #254: a busy Agent answers with a QueuedMessageReceipt instead of a started Run.
  // (#404: rerun lineage moved server-side — see api.rerun; no client-sent rerunOf any more.)
  sendMessage: (id: string, content: string) =>
    request<{ run: AgentRun; message: Message } | QueuedMessageReceipt>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),
  // #254: cancel a message still waiting in the Agent's queue.
  cancelPendingMessage: (agentId: string, messageId: string) =>
    request<void>("/api/agents/" + agentId + "/messages/" + messageId, { method: "DELETE" }),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
  // #404: server-side rerun — the server replays the RAW stored prompt (served copies are
  // redacted since #388, so the client's copy can't be trusted for re-dispatch).
  rerun: (runId: string) =>
    request<{ run: AgentRun; message: Message } | QueuedMessageReceipt>(
      "/api/runs/" + runId + "/rerun",
      { method: "POST" },
    ),
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
  // #342: optional bucket/from/to for the charts drill-in — only provided keys become query params, so
  // existing no-opts callers hit the exact same URL as before.
  reliability: (agentId: string, opts: { bucket?: "hour" | "day"; from?: string; to?: string } = {}) => {
    const query = new URLSearchParams({
      ...(opts.bucket ? { bucket: opts.bucket } : {}),
      ...(opts.from ? { from: opts.from } : {}),
      ...(opts.to ? { to: opts.to } : {}),
    }).toString();
    return request<ReliabilityReport>("/api/agents/" + agentId + "/reliability" + (query ? "?" + query : ""));
  },
  // #369: the agent-optional all-runs variant behind the Overview dashboard.
  reliabilityAll: (opts: { bucket?: "hour" | "day"; from?: string; to?: string } = {}) => {
    const query = new URLSearchParams({
      ...(opts.bucket ? { bucket: opts.bucket } : {}),
      ...(opts.from ? { from: opts.from } : {}),
      ...(opts.to ? { to: opts.to } : {}),
    }).toString();
    return request<import("./types").ReliabilityOverviewReport>("/api/reliability" + (query ? "?" + query : ""));
  },
  // #192: the evaluator catalogue and the user-defined llm_judge create form.
  listEvaluators: () => request<{ evaluators: EvaluatorDefinition[] }>("/api/evaluators"),
  createEvaluator: (body: { name: string; rubric: string; minScore: number; maxScore: number; passThreshold: number; setsTaskOutcome?: boolean }) =>
    request<{ evaluator: EvaluatorDefinition }>("/api/evaluators", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  // #174: historical quality deltas for two behavior configurations of one Agent.
  // #369: optional bucket for the charts overlay — omitted, the server defaults to daily buckets.
  compareReliability: (agentId: string, a: string, b: string, window: { from?: string; to?: string; bucket?: "hour" | "day" } = {}) =>
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
      throw new ApiError(data.error ? humanizeErrorMessage(data.error) : "Export failed", response.status);
    }
    const disposition = response.headers.get("Content-Disposition") ?? "";
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? "trace-" + traceId + ".json";
    return { blob: await response.blob(), filename };
  },
};
