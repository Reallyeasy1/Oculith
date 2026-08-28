import type { Agent, AgentRun, Assertion, AuditRow, CapturePolicy, EvalRun, Message, RegressionCase, RunListItem, RunLogLine, SystemInfo, TraceView, Workspace, WorkspaceTemplate } from "./types";

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
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string; workspace?: string },
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
  sendMessage: (id: string, content: string) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),
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
