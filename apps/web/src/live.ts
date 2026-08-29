import type { LiveNotification } from "./types";

// #40: live updates over SSE. This module only shortens the wait — every caller keeps its polling
// loop as the safety net, so a dead stream degrades to the pre-#40 behaviour, never to a blank UI.

/** Reconnect backoff decision (pure, unit-tested): 1s, 2s, 4s, ... capped at 30s. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.min(Math.max(0, attempt), 5));
}

/** EventSource cannot set Authorization, so the shared token travels as ?access_token= — the server
 * accepts it on this route only and scrubs it from its request log (apps/server/src/app.ts). */
export function streamUrl(token: string): string {
  return "/api/events/stream" + (token ? "?access_token=" + encodeURIComponent(token) : "");
}

export function parseNotification(data: string): LiveNotification | null {
  try {
    const value = JSON.parse(data) as Partial<LiveNotification> | null;
    return value && value.type === "run.updated" && typeof value.runId === "string" && typeof value.agentId === "string"
      ? (value as LiveNotification)
      : null;
  } catch {
    return null;
  }
}

/** Opens the SSE stream and keeps it open with capped exponential backoff. Returns a disposer.
 * EventSource retries transparently while CONNECTING; only a CLOSED source (non-200 response,
 * server gone) needs the manual reopen below. */
export function connectLive(getToken: () => string, onNotify: (notification: LiveNotification) => void): () => void {
  let source: EventSource | null = null;
  let timer: number | null = null;
  let attempt = 0;
  let disposed = false;
  const open = () => {
    if (disposed) return;
    source = new EventSource(streamUrl(getToken()));
    source.onopen = () => { attempt = 0; };
    source.onmessage = (event) => {
      const notification = parseNotification(String(event.data));
      if (notification) onNotify(notification);
    };
    source.onerror = () => {
      if (source?.readyState !== EventSource.CLOSED) return; // built-in retry is still on the case
      source.close();
      source = null;
      timer = window.setTimeout(open, reconnectDelayMs(attempt++));
    };
  };
  open();
  return () => {
    disposed = true;
    if (timer !== null) window.clearTimeout(timer);
    source?.close();
  };
}
