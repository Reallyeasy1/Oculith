import { describe, expect, it } from "vitest";
import { LiveNotifier, redactAccessToken, type LiveNotification } from "./live.js";

const notification: LiveNotification = { type: "run.updated", runId: "run-1", agentId: "agt-1", status: "running", ts: "2026-08-29T00:00:00.000Z" };

describe("LiveNotifier", () => {
  it("fans a notification out to every subscriber and stops after unsubscribe", () => {
    const notifier = new LiveNotifier();
    const seen: LiveNotification[] = [];
    const offA = notifier.subscribe((n) => seen.push(n));
    notifier.subscribe((n) => seen.push(n));
    expect(notifier.listenerCount).toBe(2);
    notifier.publish(notification);
    expect(seen).toHaveLength(2);
    offA();
    expect(notifier.listenerCount).toBe(1);
    notifier.publish(notification);
    expect(seen).toHaveLength(3);
  });

  it("swallows a throwing listener and still notifies the others (invariant 4)", () => {
    const notifier = new LiveNotifier();
    const seen: LiveNotification[] = [];
    notifier.subscribe(() => { throw new Error("broken client"); });
    notifier.subscribe((n) => seen.push(n));
    expect(() => notifier.publish(notification)).not.toThrow();
    expect(seen).toHaveLength(1);
  });
});

describe("redactAccessToken", () => {
  it("drops the stream route's whole query string — a name-literal scrub misses encoded names", () => {
    expect(redactAccessToken("/api/events/stream?access_token=sekret")).toBe("/api/events/stream");
    expect(redactAccessToken("/api/events/stream?a=1&access_token=sekret&b=2")).toBe("/api/events/stream");
    // URLSearchParams percent-decodes parameter NAMES, so this authenticates; the log must not keep it.
    expect(redactAccessToken("/api/events/stream?%61ccess_token=sekret")).toBe("/api/events/stream");
  });

  it("scrubs a stray access_token on any other route", () => {
    expect(redactAccessToken("/api/runs?access_token=sekret")).toBe("/api/runs?access_token=[REDACTED]");
  });

  it("leaves token-free URLs untouched", () => {
    expect(redactAccessToken("/api/runs?limit=10")).toBe("/api/runs?limit=10");
    expect(redactAccessToken("/api/health")).toBe("/api/health");
  });
});
