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
 * #370: which preview command the UI starts. Static wins whenever a built dist/index.html exists:
 * the platform's vite command is `vite preview`, which serves that same dist/ — but through the
 * workspace's node_modules, whose native rollup/esbuild bindings only exist for the platform that
 * ran `npm install` (a host install boots nothing inside the Linux preview container), and vite 5
 * cannot even load its config on the read-only workspace mount (EROFS on its temp file). The
 * stdlib static server has neither failure mode and serves identical content. Vite is only picked
 * when it is the sole servable command; null = nothing servable, the Preview button stays hidden.
 */
export function preferredPreviewCommand(servable: PreviewServability | null): PreviewCommand | null {
  if (servable?.static) return "static";
  if (servable?.vite) return "vite";
  return null;
}
