import type { Agent, AgentRun, AuditRow, CapturePolicy, Message, RunListItem, SystemInfo, TraceView, WorkspaceTemplate } from "./types";

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
  listWorkspaces: () => request<{ workspaces: { name: string; path: string; agents: string[]; fileCount: number; lastModified: string; managed: boolean }[] }>("/api/workspaces"),
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
