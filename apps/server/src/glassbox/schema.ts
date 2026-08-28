import { randomUUID } from "node:crypto";
import { z } from "zod";

export const SCHEMA_VERSION = "1.0" as const; // additive event types do not bump the version: a bump would make every stored 1.0 line unreadable
export const REDACTION_RULESET_VERSION = "1" as const;

export const STATUSES = ["running", "ok", "error", "cancelled", "timeout", "unset"] as const;
export const CATEGORIES = [
  "experience", "control", "runtime", "model", "tool", "workspace", "sandbox", "policy", "infrastructure",
] as const;
export const EVENT_TYPES = [
  "run.created", "run.started", "run.completed", "run.failed", "run.cancelled", "run.timed_out",
  "http.request.received", "http.request.completed",
  "agent_service.run.started", "agent_service.run.completed", "agent_service.run.failed",
  "runtime.container.started", "runtime.container.stopped",
  "runtime.codex.started", "runtime.codex.first_output", "runtime.codex.completed", "runtime.codex.failed",
  "runtime.postcheck.started", "runtime.postcheck.completed", "runtime.postcheck.failed",
  "model.request", "model.completed",
  "tool.call.started", "tool.call.completed", "tool.call.failed",
  "workspace.changed", "policy.denied", "redaction.applied", "limit.exceeded",
  "error.recorded", "telemetry.degraded", "trace.truncated", "capability.unavailable",
] as const;
export const CAPTURE_POLICIES = ["metadata_only", "safe_summary"] as const;

export const statusSchema = z.enum(STATUSES);
export const categorySchema = z.enum(CATEGORIES);
export const eventTypeSchema = z.enum(EVENT_TYPES);
export const capturePolicySchema = z.enum(CAPTURE_POLICIES);

const primitive = z.union([z.string().max(2048), z.number(), z.boolean(), z.null()]);
// One bound for every identifier: ids are opaque tokens we generate or copy from headers, never content.
const id = z.string().min(1).max(128);

export const observationEventSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  eventId: id,
  sequence: z.number().int().nonnegative(),
  traceId: id,
  spanId: id,
  parentSpanId: id.optional(),
  runId: id,
  agentId: id,
  sessionId: id.optional(),
  requestId: id.optional(),
  actorId: id.default("local-user"),
  actorType: z.enum(["human", "service", "agent", "controller"]).default("human"),
  attempt: z.number().int().positive().default(1),
  timestamp: z.string().datetime(),
  type: eventTypeSchema,
  category: categorySchema,
  phase: z.enum(["start", "end", "instant"]).default("instant"),
  status: statusSchema.default("unset"),
  name: z.string().min(1).max(120),
  durationMs: z.number().nonnegative().optional(),
  source: z.object({
    component: z.string().min(1).max(64),
    adapter: z.string().min(1).max(64).optional(),
    observed: z.boolean(),
  }),
  attributes: z.record(z.string().max(64), primitive).refine((a) => Object.keys(a).length <= 64, "attributes: at most 64 keys").default({}),
  summary: z.object({ text: z.string().max(4096), policy: z.literal("safe_summary") }).optional(),
  error: z.object({ type: z.string().max(64), message: z.string().max(2048) }).optional(),
  privacy: z.object({
    redacted: z.boolean(),
    rulesetVersion: z.string().max(64),
    reason: z.string().max(64).optional(),
    rules: z.array(z.string().max(64)).max(32).optional(),
    originalBytes: z.number().int().nonnegative().optional(),
    storedBytes: z.number().int().nonnegative().optional(),
  }),
});

export const eventInputSchema = observationEventSchema.omit({
  schemaVersion: true, eventId: true, sequence: true, timestamp: true, privacy: true,
}).extend({ timestamp: z.string().datetime().optional() });

export type ObservationEvent = z.infer<typeof observationEventSchema>;
export type EventInput = z.input<typeof eventInputSchema>;
export type TraceStatus = z.infer<typeof statusSchema>;
export type Category = z.infer<typeof categorySchema>;
export type EventType = z.infer<typeof eventTypeSchema>;
export type CapturePolicy = z.infer<typeof capturePolicySchema>;

export function newId(prefix: "trc" | "spn" | "evt"): string {
  return prefix + "_" + randomUUID().replace(/-/g, "").slice(0, 20);
}
