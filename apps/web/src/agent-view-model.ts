import type { PreviewCommand, PreviewServability, RunStatus } from "./types";

// #266: a failed Run leaves the Agent `ready`; `lastError` is the persisted (redacted) evidence,
// cleared by the server on the next completed Run. The hint shows only when nothing fresher is on
// screen: the run-error card owns `failed`, the activity strip owns `queued`/`running`. With no
// activeRun (reload, agent switch) the persisted evidence is all we have — show it.
export function showLastErrorHint(lastError: string | null, activeRunStatus: RunStatus | null): boolean {
  if (!lastError) return false;
  return activeRunStatus === null || !["queued", "running", "failed"].includes(activeRunStatus);
}

/**
 * #370/#375: which preview command the UI starts — static (the only command since vite's
 * retirement) when the workspace has a built dist/index.html; null keeps the Preview button hidden.
 */
export function preferredPreviewCommand(servable: PreviewServability | null): PreviewCommand | null {
  return servable?.static ? "static" : null;
}
