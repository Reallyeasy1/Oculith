import { describe, expect, it } from "vitest";
import { parseNotification, reconnectDelayMs, streamUrl } from "./live";

describe("reconnectDelayMs (#40)", () => {
  it("backs off exponentially from 1s and caps at 30s", () => {
    expect(reconnectDelayMs(0)).toBe(1_000);
    expect(reconnectDelayMs(1)).toBe(2_000);
    expect(reconnectDelayMs(2)).toBe(4_000);
    expect(reconnectDelayMs(5)).toBe(30_000);
    expect(reconnectDelayMs(50)).toBe(30_000);
  });

  it("treats a negative attempt as the first", () => {
    expect(reconnectDelayMs(-3)).toBe(1_000);
  });
});

describe("streamUrl", () => {
  it("appends the token as an encoded access_token query param", () => {
    expect(streamUrl("s3kret+/=")).toBe("/api/events/stream?access_token=s3kret%2B%2F%3D");
  });

  it("omits the param entirely when no token is configured", () => {
    expect(streamUrl("")).toBe("/api/events/stream");
  });
});

describe("parseNotification", () => {
  it("accepts a well-formed run.updated frame", () => {
    const parsed = parseNotification('{"type":"run.updated","runId":"run-1","agentId":"agt-1","status":"ok","ts":"2026-08-29T00:00:00.000Z"}');
    expect(parsed).toMatchObject({ type: "run.updated", runId: "run-1", agentId: "agt-1" });
  });

  it("rejects unknown types, malformed shapes and non-JSON without throwing", () => {
    expect(parseNotification('{"type":"something.else","runId":"r","agentId":"a"}')).toBeNull();
    expect(parseNotification('{"type":"run.updated"}')).toBeNull();
    expect(parseNotification("null")).toBeNull();
    expect(parseNotification(":hb")).toBeNull();
  });
});
