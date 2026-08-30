import { describe, expect, it } from "vitest";
import { buildTrace, type TraceView } from "../glassbox/query.js";
import { SCHEMA_VERSION, type ObservationEvent } from "../glassbox/schema.js";
import { assertionSchema, evaluateAll } from "./evaluators.js";

let sequence = 0;
const event = (over: Partial<ObservationEvent> & Pick<ObservationEvent, "type" | "category" | "spanId">): ObservationEvent => ({
  schemaVersion: SCHEMA_VERSION, eventId: "evt_" + ++sequence, sequence, traceId: "trc_1", runId: "run_1", agentId: "agent_1",
  actorId: "local-user", actorType: "human", attempt: 1, timestamp: new Date(1_700_000_000_000 + sequence * 10).toISOString(),
  phase: "instant", status: "unset", name: over.type, source: { component: "test", observed: true }, attributes: {}, privacy: { redacted: false, rulesetVersion: "1" }, ...over,
});

function view(): TraceView {
  sequence = 0;
  return buildTrace([
    event({ type: "run.created", category: "control", spanId: "create", status: "ok" }),
    event({ type: "tool.call.started", category: "tool", spanId: "tool", phase: "start", status: "running", name: "shell:node", attributes: { program: "node" } }),
    event({ type: "tool.call.completed", category: "tool", spanId: "tool", phase: "end", status: "ok", name: "shell:node", attributes: { program: "node" } }),
    event({ type: "run.completed", category: "control", spanId: "done", status: "ok" }),
  ], { capturePolicy: "metadata_only" });
}

describe("evaluator registry", () => {
  it("rejects unknown assertion types", () => {
    expect(assertionSchema.safeParse({ type: "llm_judge" })).toMatchObject({ success: false });
  });

  it("evaluates trace assertions with only stored event ids as evidence", async () => {
    const trace = view();
    const results = await evaluateAll(trace, [
      { type: "terminal_status", expected: "ok" },
      { type: "expected_tool", program: "node" },
      { type: "max_tool_calls", max: 1 },
      { type: "max_duration_ms", max: 100 },
    ]);
    expect(results.every((item) => item.pass)).toBe(true);
    expect(results.flatMap((item) => item.evidenceEventIds).every((id) => trace.events.some((event) => event.eventId === id))).toBe(true);
  });

  it("#283: expected_tool matches argument0, so a wrapped command is assertable on both runtimes", async () => {
    sequence = 0;
    const trace = buildTrace([
      event({ type: "run.created", category: "control", spanId: "create", status: "ok" }),
      // Windows shape: every command is the powershell wrapper; argument0 is the script's first token.
      event({ type: "tool.call.completed", category: "tool", spanId: "t1", status: "ok", name: "shell:powershell.exe", attributes: { program: "powershell.exe", argument0: "npm" } }),
      event({ type: "run.completed", category: "control", spanId: "done", status: "ok" }),
    ], { capturePolicy: "metadata_only" });
    const [byArg, byWrapper, absent] = await evaluateAll(trace, [
      { type: "expected_tool", program: "npm" },
      { type: "expected_tool", program: "powershell.exe" },
      { type: "expected_tool", program: "git" },
    ]);
    expect(byArg!.pass).toBe(true);
    expect(byWrapper!.pass).toBe(true);
    expect(absent!.pass).toBe(false);
    // #346: observed names the matched command, not just the wrapper shell identity.
    expect(byArg!.observed).toBe("shell:powershell.exe npm");
    expect(byWrapper!.observed).toBe("shell:powershell.exe npm");
    expect(absent!.observed).toBeNull();
  });

  it("reports failing tool, count, duration, and terminal-status assertions", async () => {
    const results = await evaluateAll(view(), [
      { type: "terminal_status", expected: "error" },
      { type: "expected_tool", program: "python" },
      { type: "max_tool_calls", max: 0 },
      { type: "max_duration_ms", max: 1 },
    ]);
    expect(results.map((item) => item.pass)).toEqual([false, false, false, false]);
  });

  it("runs only an allow-listed post-check and preserves its event evidence", async () => {
    const trace = view();
    const [pass] = await evaluateAll(trace, [{ type: "post_check", command: "npm test", timeoutMs: 100 }], {
      workspacePath: "/workspace",
      allowedPostCheckCommands: ["npm test"],
      runPostCheck: async () => ({ exitCode: 0, evidenceEventIds: [trace.events.at(-1)!.eventId] }),
    });
    expect(pass).toMatchObject({ pass: true, observed: 0, evidenceEventIds: [trace.events.at(-1)!.eventId] });
  });

  it("reports timed-out and disallowed post-checks as failures", async () => {
    const trace = view();
    const [timedOut, denied] = await evaluateAll(trace, [
      { type: "post_check", command: "npm test", timeoutMs: 20 },
      { type: "post_check", command: "rm -rf .", timeoutMs: 20 },
    ], {
      workspacePath: "/workspace",
      allowedPostCheckCommands: ["npm test"],
      runPostCheck: async () => ({ exitCode: 143, timedOut: true, evidenceEventIds: [trace.events.at(-1)!.eventId] }),
    });
    expect(timedOut).toMatchObject({ pass: false, message: "Post-check timed out after 20 ms." });
    expect(denied).toMatchObject({ pass: false, message: "Post-check command is not allow-listed for this workspace template." });
  });
});
