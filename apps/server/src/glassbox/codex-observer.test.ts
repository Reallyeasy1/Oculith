import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexStreamObserver } from "./codex-observer.js";
import { ObservationEmitter } from "./emitter.js";
import { MemoryTraceStore } from "./store.js";
import { parseCodexEventLine, type ParsedEvents } from "../codex-runner.js";

const trace = { traceId: "trc_1", runId: "run-1", agentId: "agt-1", parentSpanId: "spn_rt" };
const parsed = (): ParsedEvents => ({ messages: [], threadId: null, usage: null, errors: [] });

const lines = [
  JSON.stringify({ type: "thread.started", thread_id: "thr-1" }),
  JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "SECRET THOUGHTS" } }),
  JSON.stringify({
    type: "item.completed",
    item: {
      type: "command_execution",
      command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz' x",
      exit_code: 0,
      aggregated_output: "ok",
    },
  }),
  JSON.stringify({
    type: "item.completed",
    item: { type: "command_execution", command: "npm test", exit_code: 1, aggregated_output: "1 failing" },
  }),
  JSON.stringify({
    type: "item.completed",
    item: {
      type: "file_change",
      changes: [
        { path: "src/a.ts", kind: "add" },
        { path: "src/b.ts", kind: "update" },
      ],
    },
  }),
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Done" } }),
  JSON.stringify({ type: "turn.started" }),
  JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 } }),
] as const;

describe("CodexStreamObserver", () => {
  it("maps observed items to tool/workspace/model events, never stores reasoning, and redacts commands", async () => {
    const store = new MemoryTraceStore();
    const em = new ObservationEmitter({ store, capturePolicy: "safe_summary" });
    const obs = new CodexStreamObserver(em, trace, "spn_rt", "CodexRunner");
    const p = parsed();
    for (const line of lines) parseCodexEventLine(line, p, obs);
    obs.finish();
    await em.flush();

    const events = await store.readRun("run-1");
    expect(obs.sessionId).toBe("thr-1");
    expect(events.map((e) => e.type)).toEqual([
      "tool.call.completed",
      "tool.call.failed",
      "workspace.changed",
      "model.request",
      "model.completed",
    ]);
    expect(events.every((e) => e.parentSpanId === "spn_rt" && e.source.observed)).toBe(true);
    expect(events.every((e) => e.sessionId === "thr-1")).toBe(true);
    // The agent chose these actions: attribute them to it, not to the local user (#135).
    expect(events.every((e) => e.actorType === "agent" && e.actorId === "agt-1")).toBe(true);
    expect(events[0]!.attributes.exitCode).toBe(0);
    expect(events[0]!.attributes.program).toBe("curl");
    expect(events[0]!.summary?.text).toContain("[REDACTED:bearer]");
    expect(events[1]).toMatchObject({ status: "error", error: { type: "exit_code", message: "exit code 1" } });
    expect(events[2]!.attributes).toMatchObject({ fileCount: 2, added: 1, updated: 1 });
    expect(events[3]).toMatchObject({ name: "model.turn", phase: "start", status: "running", attributes: { turnIndex: 1 } });
    expect(events[4]).toMatchObject({ name: "model.turn", phase: "end", status: "ok", attributes: { turnIndex: 1, inputTokens: 100, cachedInputTokens: 40, outputTokens: 7 } });
    expect(events[4]!.spanId).toBe(events[3]!.spanId);
    expect(JSON.stringify(events)).not.toContain("SECRET THOUGHTS");
    expect(events.some((e) => e.type === "capability.unavailable")).toBe(false);
  });

  it("emits one timed model.turn span per turn and leaves a cut-short turn incomplete", async () => {
    const store = new MemoryTraceStore();
    const em = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const obs = new CodexStreamObserver(em, trace, "spn_rt", "CodexRunner");
    const p = parsed();
    for (const line of [
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }),
      JSON.stringify({ type: "turn.started" }),
    ]) parseCodexEventLine(line, p, obs);
    obs.finish("cancelled");
    await em.flush();

    const events = await store.readRun("run-1");
    expect(events.map((event) => [event.name, event.phase])).toEqual([
      ["model.turn", "start"],
      ["model.turn", "end"],
      ["model.turn", "start"],
    ]);
    expect(events[0]!.spanId).toBe(events[1]!.spanId);
    expect(events[2]!.spanId).not.toBe(events[0]!.spanId);
    expect(events.map((event) => event.attributes.turnIndex)).toEqual([1, 1, 2]);
  });

  it("metadata_only keeps command text and its secrets out entirely", async () => {
    const store = new MemoryTraceStore();
    const em = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const obs = new CodexStreamObserver(em, trace, "spn_rt", "CodexRunner");
    parseCodexEventLine(lines[2]!, parsed(), obs);
    await em.flush();

    const [e] = await store.readRun("run-1");
    expect(e!.summary).toBeUndefined();
    // The program token survives as metadata; the arguments and the credential never do.
    expect(e!.attributes.program).toBe("curl");
    const serialised = JSON.stringify(e);
    expect(serialised).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(serialised).not.toContain("Authorization");
    expect(e!.attributes.commandBytes).toBeGreaterThan(0);
  });

  it("emits exactly one capability.unavailable when the stream exposes only messages", async () => {
    const store = new MemoryTraceStore();
    const em = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const obs = new CodexStreamObserver(em, trace, "spn_rt", "ContainerCodexRunner");
    parseCodexEventLine(lines[0]!, parsed(), obs);
    parseCodexEventLine(lines[5]!, parsed(), obs);
    obs.finish();
    obs.finish();
    await em.flush();

    const events = await store.readRun("run-1");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "capability.unavailable",
      actorType: "service", actorId: "runner",
      attributes: { model: false, tool: false },
    });
  });

  it("treats a non-fatal item error and a null exit code as neither failure nor tool evidence", async () => {
    const store = new MemoryTraceStore();
    const em = new ObservationEmitter({ store, capturePolicy: "safe_summary" });
    const obs = new CodexStreamObserver(em, trace, "spn_rt", "CodexRunner");
    // docs/CODEX_EVENTS.md E8: every successful Ark run carries this item.
    parseCodexEventLine(
      JSON.stringify({ type: "item.completed", item: { type: "error", message: "Model metadata not found." } }),
      parsed(),
      obs,
    );
    // E3: item.started carries exit_code null and is never a completion.
    parseCodexEventLine(
      JSON.stringify({
        type: "item.started",
        item: { type: "command_execution", command: "sh -lc x", exit_code: null, status: "in_progress" },
      }),
      parsed(),
      obs,
    );
    obs.finish();
    await em.flush();

    const events = await store.readRun("run-1");
    expect(events.map((e) => e.type)).toEqual(["capability.unavailable"]);
  });

  it("records a declined command (exit_code -1) as a denied tool failure", async () => {
    const store = new MemoryTraceStore();
    const em = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const obs = new CodexStreamObserver(em, trace, "spn_rt", "CodexRunner");
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "pwsh -c x",
          exit_code: -1,
          status: "declined",
          aggregated_output: "rejected: blocked by policy",
        },
      }),
      parsed(),
      obs,
    );
    await em.flush();

    const events = await store.readRun("run-1");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "tool.call.failed", status: "error", error: { type: "denied" } });
    expect(events[0]!.attributes.exitCode).toBe(-1);
    expect(events[1]).toMatchObject({
      type: "policy.denied", category: "policy", status: "error", name: "pwsh",
      actorId: "sandbox", actorType: "service", source: { component: "Sandbox" },
      attributes: { program: "pwsh", decision: "sandbox_declined", commandBytes: 9 },
    });
    expect(events[1]!.attributes).not.toHaveProperty("command");
    expect(events[1]!.summary).toBeUndefined();
  });

  it("emits one error.recorded from the buffered stream error only when the run failed", async () => {
    const store = new MemoryTraceStore();
    const em = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const obs = new CodexStreamObserver(em, trace, "spn_rt", "CodexRunner");
    obs.onError("Reconnecting... 1/5");
    obs.onError("unexpected status 401 Unauthorized");
    obs.finish("error");
    await em.flush();

    const events = await store.readRun("run-1");
    expect(events.filter((e) => e.type === "error.recorded")).toHaveLength(1);
    expect(events.find((e) => e.type === "error.recorded")!.error).toEqual({
      type: "codex_error",
      message: "unexpected status 401 Unauthorized",
    });
  });

  it("suppresses capability.unavailable on a run cut short, but still emits it on a normal finish", async () => {
    const run = async (outcome: "ok" | "timeout" | "cancelled") => {
      const store = new MemoryTraceStore();
      const em = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
      // The stream ran (thread.started) but no tool or model line was ever seen — is that evidence?
      const obs = new CodexStreamObserver(em, trace, "spn_rt", "CodexRunner");
      parseCodexEventLine(lines[0]!, parsed(), obs);
      obs.finish(outcome);
      await em.flush();
      return (await store.readRun("run-1")).map((e) => e.type);
    };
    expect(await run("timeout")).toEqual([]);
    expect(await run("cancelled")).toEqual([]);
    expect(await run("ok")).toEqual(["capability.unavailable"]);
  });

  it("emits no capability.unavailable when no stream event was observed at all (spawn failure, early abort)", async () => {
    const store = new MemoryTraceStore();
    const em = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    new CodexStreamObserver(em, trace, "spn_rt", "CodexRunner").finish("error");
    await em.flush();
    expect(await store.readRun("run-1")).toEqual([]);
  });

  it.each([
    ["C:\\Users\\someone\\AppData\\Roaming\\npm\\codex.exe --version", "codex.exe"],
    ["/usr/local/bin/git status", "git"],
    ["curl -s x", "curl"],
  ])("stores only the basename of the program token: %s", async (command, program) => {
    const store = new MemoryTraceStore();
    const em = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const obs = new CodexStreamObserver(em, trace, "spn_rt", "CodexRunner");
    parseCodexEventLine(
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", command, exit_code: 0 } }),
      parsed(),
      obs,
    );
    await em.flush();
    const [e] = await store.readRun("run-1");
    expect(e!.attributes.program).toBe(program);
    expect(e!.name).toBe("shell:" + program);
    expect(JSON.stringify(e)).not.toContain("someone");
  });

  it("drops the buffered stream error when the run succeeded", async () => {
    const store = new MemoryTraceStore();
    const em = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const obs = new CodexStreamObserver(em, trace, "spn_rt", "CodexRunner");
    obs.onError("Reconnecting... 1/5");
    parseCodexEventLine(lines[7]!, parsed(), obs);
    obs.finish();
    await em.flush();

    const events = await store.readRun("run-1");
    expect(events.map((e) => e.type)).toEqual(["model.completed"]);
  });
});

// vitest runs with cwd apps/server, hence the ../..
const fixtureDir = path.join(process.cwd(), "..", "..", "fixtures", "codex-stream");
const feed = async (
  name: string,
  capturePolicy: "metadata_only" | "safe_summary",
  outcome: "ok" | "error" | "cancelled" | "timeout" = "ok",
) => {
  const store = new MemoryTraceStore();
  const em = new ObservationEmitter({ store, capturePolicy });
  const obs = new CodexStreamObserver(em, trace, "spn_rt", "CodexRunner");
  const p = parsed();
  for (const line of readFileSync(path.join(fixtureDir, name), "utf8").split(/\r?\n/)) {
    if (line.trim()) parseCodexEventLine(line, p, obs);
  }
  obs.finish(outcome);
  await em.flush();
  return { events: await store.readRun("run-1"), parsed: p, obs };
};

describe.skipIf(!existsSync(fixtureDir))("CodexStreamObserver against real captures", () => {
  it.each(["codex-0.111.jsonl", "codex-0.142.jsonl"])(
    "%s maps one shell tool call and the turn usage",
    async (name) => {
      const { events, obs } = await feed(name, "safe_summary");
      const types = events.map((e) => e.type);
      expect(obs.sessionId).toBeTruthy();
      expect(types.filter((t) => t.startsWith("tool.call.")).length).toBeGreaterThanOrEqual(1);
      expect(types).toContain("model.completed");
      expect(types).not.toContain("capability.unavailable");
      // E7/E8: reasoning text and the non-fatal notice never reach the store.
      expect(JSON.stringify(events)).not.toContain("The task is simple");
      expect(JSON.stringify(events)).not.toContain("Model metadata");
      // No file_change was ever observed, so no workspace event may be invented.
      expect(types).not.toContain("workspace.changed");
    },
  );

  it("codex-0.142-sandbox-denied.jsonl maps the declined command to tool.call.failed", async () => {
    const { events } = await feed("codex-0.142-sandbox-denied.jsonl", "metadata_only");
    const failure = events.find((e) => e.type === "tool.call.failed");
    expect(failure).toBeDefined();
    expect(failure!.error).toMatchObject({ type: "denied" });
    expect(failure!.attributes.exitCode).toBe(-1);
  });

  it("codex-0.111-turn-failed.jsonl keeps the started model turn plus one error.recorded", async () => {
    const { events, parsed: p } = await feed("codex-0.111-turn-failed.jsonl", "metadata_only", "error");
    const types = events.map((e) => e.type);
    expect(types).toContain("model.request");
    expect(types).not.toContain("capability.unavailable");
    expect(types.filter((t) => t === "error.recorded")).toHaveLength(1);
    // trap 1: turn.failed nests its message under error.message.
    expect(p.errors.at(-1)).toContain("401 Unauthorized");
    expect(JSON.stringify(events)).not.toContain("Reconnecting... 1/5");
  });
});
