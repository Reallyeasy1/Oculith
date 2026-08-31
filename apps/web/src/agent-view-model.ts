import { formatClock } from "./runs-view-model";
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

/**
 * #395: a message that waited in the queue shows its Run moment as the timestamp; the send moment
 * must be visible text, not a tooltip. Null when the message never queued, the send time is
 * malformed, or both clock readings would print the same string ("sent 14:03, ran 14:03" reads
 * like a bug, and the distinction is imperceptible anyway).
 */
export function queuedSentNote(message: { createdAt: string; queuedAt?: string }): string | null {
  if (!message.queuedAt) return null;
  const sent = formatClock(message.queuedAt);
  if (sent === "—" || sent === formatClock(message.createdAt)) return null;
  return "sent " + sent;
}
