import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  ACTOR_TYPES, CAPTURE_POLICIES, CATEGORIES, EVENT_TYPES, SCHEMA_VERSION, STATUSES,
  capturesSummaries, eventInputSchema, newId, observationEventSchema,
} from "./schema.js";
import { createTraceContext } from "./context.js";

const base = {
  schemaVersion: SCHEMA_VERSION, eventId: "evt_1", sequence: 0,
  traceId: "trc_1", spanId: "spn_1", runId: "run-1", agentId: "agt-1",
  timestamp: "2026-08-26T00:00:00.000Z", type: "run.created", category: "control",
  name: "run.created", source: { component: "AgentService", observed: true },
  privacy: { redacted: false, rulesetVersion: "1" },
};

describe("ObservationEvent schema", () => {
  it("accepts a minimal valid event and fills defaults", () => {
    const parsed = observationEventSchema.parse(base);
    expect(parsed.status).toBe("unset");
    expect(parsed.phase).toBe("instant");
    expect(parsed.actorId).toBe("local-user");
    expect(parsed.attempt).toBe(1);
    expect(parsed.attributes).toEqual({});
  });
  it("rejects bad status, missing traceId and non-primitive attributes", () => {
    expect(() => observationEventSchema.parse({ ...base, status: "done" })).toThrow();
    expect(() => observationEventSchema.parse({ ...base, traceId: "" })).toThrow();
    expect(() => observationEventSchema.parse({ ...base, attributes: { nested: { a: 1 } } })).toThrow();
  });
  it("bounds ids, attribute key count and privacy fields", () => {
    expect(() => observationEventSchema.parse({ ...base, traceId: "t".repeat(129) })).toThrow(ZodError);
    expect(() => observationEventSchema.parse({ ...base, traceId: "t".repeat(128) })).not.toThrow();
    const many: Record<string, number> = {}; for (let i = 0; i < 65; i++) many["k" + i] = i;
    expect(() => observationEventSchema.parse({ ...base, attributes: many })).toThrow(ZodError);
    delete many.k64;
    expect(() => observationEventSchema.parse({ ...base, attributes: many })).not.toThrow();
    expect(() => observationEventSchema.parse({ ...base, privacy: { redacted: true, rulesetVersion: "v".repeat(65) } })).toThrow(ZodError);
    expect(() => observationEventSchema.parse({ ...base, privacy: { ...base.privacy, rules: Array.from({ length: 33 }, () => "r") } })).toThrow(ZodError);
  });
  it("every taxonomy type and category is accepted", () => {
    for (const type of EVENT_TYPES) expect(() => observationEventSchema.parse({ ...base, type })).not.toThrow();
    for (const category of CATEGORIES) expect(() => observationEventSchema.parse({ ...base, category })).not.toThrow();
    expect(STATUSES).toEqual(["running", "ok", "error", "cancelled", "timeout", "unset"]);
  });
  it("redaction.applied is not an event type: redaction outcome lives inline on privacy (PRD, #59)", () => {
    expect(EVENT_TYPES).not.toContain("redaction.applied");
    expect(() => observationEventSchema.parse({ ...base, type: "redaction.applied" })).toThrow(ZodError);
  });
  it("actorType comes from the single ACTOR_TYPES enum and rejects unknown actors", () => {
    for (const actorType of ACTOR_TYPES) expect(() => observationEventSchema.parse({ ...base, actorType })).not.toThrow();
    expect(() => observationEventSchema.parse({ ...base, actorType: "robot" })).toThrow(ZodError);
  });
  it.each([
    ["2026-08-26T00:00:00.000Z", true],
    ["2026-08-26T00:00:00Z", true],
    ["2026-08-26", false], // date-only is not a datetime
    ["not-a-date", false],
  ])("timestamp %s accepted=%s (z.iso.datetime, zod 4)", (timestamp, ok) => {
    expect(observationEventSchema.safeParse({ ...base, timestamp }).success).toBe(ok);
    expect(eventInputSchema.safeParse({
      traceId: "trc_1", spanId: "spn_1", runId: "r", agentId: "a", type: "run.created",
      category: "control", name: "run.created", source: { component: "x", observed: true }, timestamp,
    }).success).toBe(ok);
  });
  it("eventInputSchema omits generated fields", () => {
    const input = eventInputSchema.parse({
      traceId: "trc_1", spanId: "spn_1", runId: "r", agentId: "a", type: "run.created",
      category: "control", name: "run.created", source: { component: "x", observed: true },
    });
    expect("eventId" in input).toBe(false);
    expect(input.status).toBe("unset");
  });
  it("capturesSummaries is the one policy gate: true for both summary tiers, false for metadata_only (#259)", () => {
    expect(capturesSummaries("safe_summary")).toBe(true);
    expect(capturesSummaries("reasoning_summary")).toBe(true);
    expect(capturesSummaries("metadata_only")).toBe(false);
    // Every declared policy has an explicit answer — a new tier cannot fall through silently.
    for (const policy of CAPTURE_POLICIES) expect(typeof capturesSummaries(policy)).toBe("boolean");
  });
  it("newId prefixes and is unique", () => {
    const a = newId("evt"); const b = newId("evt");
    expect(a.startsWith("evt_")).toBe(true); expect(a).not.toBe(b); expect(a.length).toBeLessThanOrEqual(30);
  });
  it("web types.ts hand-mirrors SCHEMA_VERSION: every hardcoded literal there matches (#54)", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../../../web/src/types.ts", import.meta.url), "utf8");
    const literals = [...source.matchAll(/schemaVersion: "([^"]+)"/g)].map((m) => m[1]);
    expect(literals.length).toBeGreaterThan(0);
    for (const literal of literals) expect(literal).toBe(SCHEMA_VERSION);
  });
  it("createTraceContext binds ingress identifiers", () => {
    const ctx = createTraceContext({ requestId: "req-1", method: "POST", path: "/api/agents/x/messages" }, "metadata_only");
    expect(ctx.traceId.startsWith("trc_")).toBe(true);
    expect(ctx.rootSpanId.startsWith("spn_")).toBe(true);
    expect(ctx.actorId).toBe("local-user");
    expect(ctx.capturePolicy).toBe("metadata_only");
    expect(ctx.schemaVersion).toBe(SCHEMA_VERSION);
    expect(Date.parse(ctx.receivedAt)).not.toBeNaN();
  });
});
