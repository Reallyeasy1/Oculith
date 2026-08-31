import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexStreamObserver, commandIdentity, describeFinalMessage } from "./codex-observer.js";
import { ObservationEmitter } from "./emitter.js";
import { buildTrace } from "./query.js";
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
  it("derives bounded outcome metadata from a deterministic failure phrase list", () => {
    expect(describeFinalMessage("curl is NOT INSTALLED on this image")).toMatchObject({ reportedFailure: true, finalMessageBytes: 35 });
    expect(describeFinalMessage("Everything completed successfully").reportedFailure).toBe(false);
    expect(describeFinalMessage("x".repeat(300)).summaryText).toHaveLength(240);
  });

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
      "tool.call.completed",
      "workspace.changed",
      "model.message",
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
    // #258: the tool summary carries a redacted tail of the observed output after the command text.
    expect(events[0]!.summary?.text).toContain("\n--- output tail ---\nok");
    expect(events[1]).toMatchObject({ status: "error", error: { type: "exit_code", message: "exit code 1" } });
    expect(events[1]!.summary?.text).toBe("npm test\n--- output tail ---\n1 failing");
    expect(events[2]!.attributes).toEqual({ tool: "file_change" });
    expect(events[3]!.attributes).toMatchObject({ fileCount: 2, added: 1, updated: 1 });
    // #258: the agent message is captured as a bounded summary under safe_summary.
    expect(events[4]).toMatchObject({ type: "model.message", phase: "instant", status: "ok", attributes: { messageBytes: 4 }, summary: { text: "Done", policy: "safe_summary" } });
    expect(events[5]).toMatchObject({ name: "model.turn", phase: "start", status: "running", attributes: { turnIndex: 1 } });
    // The tool calls sit between the reasoning and the final message, so the message is evidence of a
    // second model call — the pre-tool reasoning item cannot absorb it (#230).
    expect(events[6]).toMatchObject({ name: "model.turn", phase: "end", status: "ok", attributes: { turnIndex: 1, modelCallsObserved: 2, inputTokens: 100, cachedInputTokens: 40, outputTokens: 7 } });
    expect(events[6]!.spanId).toBe(events[5]!.spanId);
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

  it("counts observed reasoning/agent_message items as model calls on the turn end, without capturing them", async () => {
    const store = new MemoryTraceStore();
    const em = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const obs = new CodexStreamObserver(em, trace, "spn_rt", "CodexRunner");
    const p = parsed();
    // A three-step run: each reasoning item is one model call; the final message came from the last
    // call (its pair), not a fourth one (#207).
    const stream = [
      { type: "turn.started" },
      { type: "item.completed", item: { id: "i1", type: "reasoning", text: "PLAN STEP ONE" } },
      { type: "item.completed", item: { id: "i2", type: "command_execution", command: "npm test", exit_code: 0, aggregated_output: "" } },
      { type: "item.completed", item: { id: "i3", type: "reasoning", text: "PLAN STEP TWO" } },
      { type: "item.completed", item: { id: "i4", type: "command_execution", command: "ls", exit_code: 0, aggregated_output: "" } },
      { type: "item.completed", item: { id: "i5", type: "reasoning", text: "WRAP UP" } },
      { type: "item.completed", item: { id: "i6", type: "agent_message", text: "Done" } },
      { type: "turn.completed", usage: { input_tokens: 9, output_tokens: 3 } },
    ];
    for (const line of stream) parseCodexEventLine(JSON.stringify(line), p, obs);
    obs.finish();
    await em.flush();

    const events = await store.readRun("run-1");
    const end = events.find((e) => e.type === "model.completed")!;
    expect(end.attributes.modelCallsObserved).toBe(3);
    expect(JSON.stringify(events)).not.toContain("PLAN STEP");
  });

  it("counts a bare agent_message as one call and resets the count across turns", async () => {
    const store = new MemoryTraceStore();
    const em = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const obs = new CodexStreamObserver(em, trace, "spn_rt", "CodexRunner");
    const p = parsed();
    // Non-reasoning models emit no reasoning items: the message is the only evidence the call happened.
    for (const line of [
      { type: "turn.started" },
      { type: "item.completed", item: { id: "i1", type: "agent_message", text: "First" } },
      { type: "turn.completed", usage: { input_tokens: 5, output_tokens: 1 } },
      { type: "turn.started" },
      { type: "turn.completed", usage: { input_tokens: 5, output_tokens: 1 } },
    ]) parseCodexEventLine(JSON.stringify(line), p, obs);
    obs.finish();
    await em.flush();

    const ends = (await store.readRun("run-1")).filter((e) => e.type === "model.completed");
    expect(ends).toHaveLength(2);
    expect(ends[0]!.attributes.modelCallsObserved).toBe(1);
    // The second turn produced no item evidence: no fabricated count.
    expect(ends[1]!.attributes).not.toHaveProperty("modelCallsObserved");
  });

  it("#243: completion-summary modelCalls equals buildTrace's count when a turn is abandoned mid-run", async () => {
    const store = new MemoryTraceStore();
    const em = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const obs = new CodexStreamObserver(em, trace, "spn_rt", "CodexRunner");
    const p = parsed();
    // First turn dies without turn.completed (E12 turn.failed → retry); the retry turn succeeds. The
    // abandoned turn's item count was never stamped on its span, so BOTH sides drop the count and
    // keep the one-call floor — the log summary and the trace rollup must agree.
    for (const line of [
      { type: "turn.started" },
      { type: "item.completed", item: { id: "i1", type: "reasoning", text: "STEP ONE" } },
      { type: "item.completed", item: { id: "i2", type: "reasoning", text: "STEP TWO" } },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "i3", type: "agent_message", text: "Done" } },
      { type: "turn.completed", usage: { input_tokens: 5, output_tokens: 1 } },
    ]) parseCodexEventLine(JSON.stringify(line), p, obs);
    obs.finish();
    await em.flush();
    const events = await store.readRun("run-1");
    const view = buildTrace(events, { capturePolicy: "metadata_only" });
    expect(view.summary.metrics.modelCalls).toBe(2);
    expect(obs.stats().modelCalls).toBe(view.summary.metrics.modelCalls);
  });

  it("#243: a turn still open when the stream ends is folded into the stats at the same floor", async () => {
    const store = new MemoryTraceStore();
    const em = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const obs = new CodexStreamObserver(em, trace, "spn_rt", "CodexRunner");
    const p = parsed();
    for (const line of [
      { type: "turn.started" },
      { type: "turn.completed", usage: { input_tokens: 5, output_tokens: 1 } },
      { type: "turn.started" },
    ]) parseCodexEventLine(JSON.stringify(line), p, obs);
    obs.finish("cancelled");
    await em.flush();
    const view = buildTrace(await store.readRun("run-1"), { capturePolicy: "metadata_only" });
    expect(view.summary.metrics.modelCalls).toBe(2);
    expect(obs.stats().modelCalls).toBe(view.summary.metrics.modelCalls);
  });

  it.each(["safe_summary", "metadata_only"] as const)(
    "#258: intermediate agent messages are captured only under safe_summary and never change the counts (%s)",
    async (capturePolicy) => {
      const store = new MemoryTraceStore();
      const em = new ObservationEmitter({ store, capturePolicy });
      const obs = new CodexStreamObserver(em, trace, "spn_rt", "CodexRunner");
      const p = parsed();
      const intermediate = "Checking with Bearer abcdefghijklmnopqrstuvwxyz next";
      for (const line of [
        { type: "turn.started" },
        { type: "item.completed", item: { id: "i1", type: "reasoning", text: "PLAN" } },
        { type: "item.completed", item: { id: "i2", type: "agent_message", text: intermediate } },
        { type: "item.completed", item: { id: "i3", type: "command_execution", command: "ls", exit_code: 0, aggregated_output: "a.txt" } },
        { type: "item.completed", item: { id: "i4", type: "agent_message", text: "x".repeat(300) } },
        { type: "turn.completed", usage: { input_tokens: 9, output_tokens: 3 } },
      ]) parseCodexEventLine(JSON.stringify(line), p, obs);
      obs.finish();
      await em.flush();

      const events = await store.readRun("run-1");
      const messages = events.filter((e) => e.type === "model.message");
      if (capturePolicy === "safe_summary") {
        expect(messages).toHaveLength(2);
        // Redacted, bounded, parented like every other observed event; messageBytes measures the original.
        expect(messages[0]!.summary?.text).toContain("[REDACTED:bearer]");
        expect(messages[0]!.summary?.text).not.toContain("abcdefghijklmnopqrstuvwxyz");
        expect(messages[0]!.privacy).toMatchObject({ redacted: true, rules: ["bearer"] });
        expect(messages[0]!.attributes.messageBytes).toBe(Buffer.byteLength(intermediate, "utf8"));
        expect(messages[1]!.summary?.text).toHaveLength(240);
        expect(messages[1]!.attributes.messageBytes).toBe(300);
        expect(messages.every((e) => e.parentSpanId === "spn_rt" && e.category === "model" && e.phase === "instant")).toBe(true);
      } else {
        // The event's only payload is content: at metadata_only it is not emitted at all.
        expect(messages).toHaveLength(0);
        expect(JSON.stringify(events)).not.toContain("Checking with");
      }
      // #207 counting is policy-independent: reasoning pairs with the first message, the post-tool
      // message is a second call.
      expect(events.find((e) => e.type === "model.completed")!.attributes.modelCallsObserved).toBe(2);
      expect(obs.stats()).toEqual({ modelCalls: 2, toolCalls: 1, toolFailures: 0, sandboxDenials: 0 });
    },
  );

  it("#259: reasoning summaries exist only under reasoning_summary; counts and stats are identical across all three policies", async () => {
    // The Bearer token straddles the 240-char window: "Bearer " ends at 226 and only 14 token chars
    // (< the pattern's 16 minimum) fit before the cut, so a slice-then-redact regression would miss the
    // match and persist raw token chars. Redact-then-slice replaces the whole token first, and the
    // 17-char placeholder ends at 236 — fully inside the window.
    const secretReasoning = "r".repeat(218) + " Bearer " + "z".repeat(40);
    const longReasoning = "PLAN " + "y".repeat(300);
    const run = async (capturePolicy: "metadata_only" | "safe_summary" | "reasoning_summary") => {
      const store = new MemoryTraceStore();
      const em = new ObservationEmitter({ store, capturePolicy });
      const obs = new CodexStreamObserver(em, trace, "spn_rt", "CodexRunner");
      const p = parsed();
      for (const line of [
        { type: "turn.started" },
        { type: "item.completed", item: { id: "i1", type: "reasoning", text: secretReasoning } },
        { type: "item.completed", item: { id: "i2", type: "command_execution", command: "ls", exit_code: 0, aggregated_output: "a.txt" } },
        { type: "item.completed", item: { id: "i3", type: "reasoning", text: longReasoning } },
        { type: "item.completed", item: { id: "i4", type: "agent_message", text: "Done" } },
        { type: "turn.completed", usage: { input_tokens: 9, output_tokens: 3 } },
      ]) parseCodexEventLine(JSON.stringify(line), p, obs);
      obs.finish();
      await em.flush();
      return { events: await store.readRun("run-1"), stats: obs.stats() };
    };

    const reasoning = await run("reasoning_summary");
    const safe = await run("safe_summary");
    const meta = await run("metadata_only");

    // reasoning_summary: one model.reasoning per observed reasoning item, parented like model.message.
    const captured = reasoning.events.filter((e) => e.type === "model.reasoning");
    expect(captured).toHaveLength(2);
    expect(captured.every((e) => e.parentSpanId === "spn_rt" && e.category === "model" && e.phase === "instant" && e.status === "ok")).toBe(true);
    expect(captured[0]!.attributes.reasoningBytes).toBe(Buffer.byteLength(secretReasoning, "utf8"));
    expect(captured[0]!.summary?.text).toContain("[REDACTED:bearer]");
    expect(captured[0]!.summary?.text).not.toContain("zzzz");
    expect(captured[1]!.attributes.reasoningBytes).toBe(Buffer.byteLength(longReasoning, "utf8"));
    expect(captured[1]!.summary?.text).toHaveLength(240);
    // Superset: everything safe_summary captures is still there.
    expect(reasoning.events.filter((e) => e.type === "model.message")).toHaveLength(1);
    expect(reasoning.events.find((e) => e.type === "tool.call.completed")?.summary?.text).toContain("ls");

    // safe_summary: ZERO model.reasoning, but model.message still present.
    expect(safe.events.filter((e) => e.type === "model.reasoning")).toHaveLength(0);
    expect(safe.events.filter((e) => e.type === "model.message")).toHaveLength(1);
    // metadata_only: neither.
    expect(meta.events.filter((e) => e.type === "model.reasoning" || e.type === "model.message")).toHaveLength(0);
    // Reasoning text never leaks below the opt-in tier.
    expect(JSON.stringify(safe.events)).not.toContain("PLAN");
    expect(JSON.stringify(meta.events)).not.toContain("PLAN");

    // #207 counting and the completion-summary stats are byte-identical across all three policies.
    for (const result of [reasoning, safe, meta]) {
      expect(result.events.find((e) => e.type === "model.completed")!.attributes.modelCallsObserved).toBe(2);
      expect(result.stats).toEqual({ modelCalls: 2, toolCalls: 1, toolFailures: 0, sandboxDenials: 0 });
    }
  });

  it("#258: a failed command's summary carries the redacted output tail, bounded to the last 512 chars", async () => {
    const store = new MemoryTraceStore();
    const em = new ObservationEmitter({ store, capturePolicy: "safe_summary" });
    const obs = new CodexStreamObserver(em, trace, "spn_rt", "CodexRunner");
    const secret = "Bearer abcdefghijklmnopqrstuvwxyz";
    const output = "x".repeat(600) + "\nerror: auth failed using " + secret;
    const command = "npm run deploy -- " + "y".repeat(1100);
    parseCodexEventLine(
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", command, exit_code: 1, status: "completed", aggregated_output: output } }),
      parsed(),
      obs,
    );
    await em.flush();

    const [e] = await store.readRun("run-1");
    expect(e!.type).toBe("tool.call.failed");
    const [commandPart, tail] = e!.summary!.text.split("\n--- output tail ---\n");
    expect(commandPart).toBe(command.slice(0, 1024)); // #258: command bound raised 512 -> 1024
    // The tail is the LAST 512 chars, so the error text at the end survives; the secret does not.
    expect(tail).toContain("error: auth failed");
    expect(tail).toContain("[REDACTED:bearer]");
    expect(e!.summary!.text).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(e!.privacy).toMatchObject({ redacted: true, rules: ["bearer"] });
    expect(output.slice(-512)).toHaveLength(512); // the seeded output really exceeded the tail bound
  });

  it("#258: redaction runs before the tail slice — a secret whose anchor is cut by the window still redacts", async () => {
    const store = new MemoryTraceStore();
    const em = new ObservationEmitter({ store, capturePolicy: "safe_summary" });
    const obs = new CodexStreamObserver(em, trace, "spn_rt", "CodexRunner");
    // The token body extends past the -512 boundary: a slice-then-redact regression would cut off the
    // "Bearer " anchor and persist ~505 bare token chars; redact-then-slice replaces the whole token first.
    const output = "deploy log\n" + "Bearer " + "a".repeat(520);
    parseCodexEventLine(
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "npm run deploy", exit_code: 1, status: "completed", aggregated_output: output } }),
      parsed(),
      obs,
    );
    await em.flush();
    const [e] = await store.readRun("run-1");
    expect(e!.summary!.text).not.toContain("a".repeat(100));
    expect(e!.summary!.text).toContain("[REDACTED:bearer]");
    expect(e!.privacy).toMatchObject({ redacted: true, rules: ["bearer"] });
  });

  it("drops an abandoned turn's item count instead of donating it to the next turn", async () => {
    const store = new MemoryTraceStore();
    const em = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const obs = new CodexStreamObserver(em, trace, "spn_rt", "CodexRunner");
    const p = parsed();
    // Turn 1 never completes (E12 turn.failed ends the stream without turn.completed); the retry
    // turn must not inherit its two reasoning items — buildTrace floors the open span at one call.
    for (const line of [
      { type: "turn.started" },
      { type: "item.completed", item: { id: "i1", type: "reasoning", text: "A" } },
      { type: "item.completed", item: { id: "i2", type: "reasoning", text: "B" } },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "i3", type: "agent_message", text: "Done" } },
      { type: "turn.completed", usage: { input_tokens: 5, output_tokens: 1 } },
    ]) parseCodexEventLine(JSON.stringify(line), p, obs);
    obs.finish();
    await em.flush();

    const end = (await store.readRun("run-1")).find((e) => e.type === "model.completed")!;
    expect(end.attributes).toMatchObject({ turnIndex: 2, modelCallsObserved: 1 });
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
      attributes: { model: true, tool: true },
    });
  });

  it.each([
    ["model", { model: false, tool: true }],
    ["tool", { model: true, tool: false }],
  ] as const)("declares only the missing %s counterpart unavailable", async (observed, unavailable) => {
    const store = new MemoryTraceStore();
    const em = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const obs = new CodexStreamObserver(em, trace, "spn_rt", "CodexRunner");
    if (observed === "model") obs.onTurnStarted();
    else obs.onItemCompleted({ type: "command_execution", command: "true", exit_code: 0 });
    obs.finish();
    await em.flush();

    const events = await store.readRun("run-1");
    expect(events.find((event) => event.type === "capability.unavailable")).toMatchObject({
      attributes: unavailable,
    });
  });

  it("treats item.started with a null exit code as running tool evidence, not a failure", async () => {
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
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "tool.call.started", phase: "start", status: "running" });
    expect(events[1]).toMatchObject({ type: "capability.unavailable", attributes: { model: true, tool: false } });
  });

  it("pairs command item lifecycle events and redacts the bounded first argument under metadata_only", async () => {
    const store = new MemoryTraceStore();
    const em = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const obs = new CodexStreamObserver(em, trace, "spn_rt", "CodexRunner");
    const command = "curl ark-11111111-2222-3333-4444-555555555555-abcdef";
    const p = parsed();
    parseCodexEventLine(JSON.stringify({ type: "item.started", item: { id: "item-secret", type: "command_execution", command, exit_code: null, status: "in_progress" } }), p, obs);
    parseCodexEventLine(JSON.stringify({ type: "item.completed", item: { id: "item-secret", type: "command_execution", command, exit_code: 0, status: "completed" } }), p, obs);
    await em.flush();

    const events = await store.readRun("run-1");
    expect(events.map((event) => [event.type, event.phase])).toEqual([
      ["tool.call.started", "start"],
      ["tool.call.completed", "end"],
    ]);
    expect(events[0]!.spanId).toBe(events[1]!.spanId);
    expect(events[1]!.attributes).toMatchObject({ program: "curl", argument0: "[REDACTED:ark_key]", exitCode: 0 });
    expect(JSON.stringify(events)).not.toContain("11111111-2222");
  });

  it("unwraps the shell wrapper so argument0 is the script's first token (E3/E4, E5 shapes)", async () => {
    const store = new MemoryTraceStore();
    const em = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const obs = new CodexStreamObserver(em, trace, "spn_rt", "CodexRunner");
    const p = parsed();
    const bash = "/bin/bash -lc 'python3 missing_script.py --token ark-11111111-2222-3333-4444-555555555555-abcdef'";
    parseCodexEventLine(JSON.stringify({ type: "item.started", item: { id: "item_2", type: "command_execution", command: bash, aggregated_output: "", exit_code: null, status: "in_progress" } }), p, obs);
    parseCodexEventLine(JSON.stringify({ type: "item.completed", item: { id: "item_2", type: "command_execution", command: bash, aggregated_output: "", exit_code: 2, status: "completed" } }), p, obs);
    // E5 verbatim: a quoted absolute powershell.exe path, -Command, a double-quoted script with escaped inner quotes.
    const ps = JSON.stringify({ type: "item.completed", item: { id: "item_3", type: "command_execution", command: '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Set-Content -LiteralPath .\\hello.txt -Value \\"hello\\"; cat .\\hello.txt"', aggregated_output: "", exit_code: 0, status: "completed" } });
    parseCodexEventLine(ps, p, obs);
    parseCodexEventLine(JSON.stringify({ type: "item.completed", item: { id: "item_4", type: "command_execution", command: "ls", aggregated_output: "", exit_code: 0, status: "completed" } }), p, obs);
    await em.flush();

    const events = await store.readRun("run-1");
    expect(events.map((e) => [e.type, e.attributes.program, e.attributes.argument0])).toEqual([
      ["tool.call.started", "bash", "python3"],
      ["tool.call.failed", "bash", "python3"],
      ["tool.call.completed", "powershell.exe", "Set-Content"],
      ["tool.call.completed", "ls", undefined],
    ]);
    expect(events[1]!.spanId).toBe(events[0]!.spanId);
    expect(events[1]).toMatchObject({ phase: "end", error: { type: "exit_code", message: "exit code 2" } });
    expect(events[2]!.phase).toBe("instant");
    expect(JSON.stringify(events)).not.toContain("missing_script");
    expect(JSON.stringify(events)).not.toContain("11111111-2222");
  });

  it("skips a leading cd wrapper so argument0 names the command that actually ran (#295)", () => {
    expect(commandIdentity("bash -lc 'cd /workspace && npm test'")).toEqual({ program: "bash", argument0: "npm" });
    expect(commandIdentity('powershell.exe -Command "cd C:\\ws; npm test"')).toEqual({ program: "powershell.exe", argument0: "npm" });
    expect(commandIdentity("bash -lc 'cd a && cd b && node x.js'")).toEqual({ program: "bash", argument0: "node" });
    expect(commandIdentity('bash -lc \'cd "/my ws" && python3 run.py\'')).toEqual({ program: "bash", argument0: "python3" });
    // Bare cd with no continuation: nothing follows, so argument0 stays cd.
    expect(commandIdentity("bash -lc 'cd /x'")).toEqual({ program: "bash", argument0: "cd" });
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
    expect(events.map((e) => e.type)).toEqual(["model.completed", "capability.unavailable"]);
    expect(events[1]!.attributes).toEqual({ model: false, tool: true });
  });
});

describe("CodexStreamObserver run-log lines (#232)", () => {
  const collect = () => {
    const entries: string[] = [];
    return {
      entries,
      log: {
        info: (message: string) => entries.push("info " + message),
        warn: (message: string) => entries.push("warn " + message),
        error: (message: string) => entries.push("error " + message),
      },
    };
  };
  const make = (options: { resumeThreadId?: string } = {}) => {
    const { entries, log } = collect();
    const em = new ObservationEmitter({ store: new MemoryTraceStore(), capturePolicy: "metadata_only" });
    const obs = new CodexStreamObserver(em, trace, "spn_rt", "CodexRunner", { log, ...options });
    return { entries, obs };
  };
  const declined = (command: string) =>
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", command, exit_code: -1, status: "declined", aggregated_output: "rejected" } });

  it("logs each of the first 5 denials individually, then one summary per 10 more", () => {
    const { entries, obs } = make();
    for (let index = 0; index < 25; index++) {
      parseCodexEventLine(declined('powershell.exe -Command "Get-ChildItem C:\\secret\\place"'), parsed(), obs);
    }
    const denialLines = entries.filter((line) => line.startsWith("warn"));
    expect(denialLines).toEqual([
      ...Array(5).fill("warn Sandbox declined shell:powershell.exe Get-ChildItem"),
      "warn 10 more sandbox denials (15 total)",
      "warn 10 more sandbox denials (25 total)",
    ]);
    expect(obs.stats()).toMatchObject({ sandboxDenials: 25, toolCalls: 25, toolFailures: 25 });
  });

  it("keeps raw command text, arguments and secrets out of every log line", () => {
    const { entries, obs } = make();
    const secret = "supersecrettoken123";
    parseCodexEventLine(declined(`/bin/bash -lc 'curl -H "Authorization: Bearer ${secret}" https://internal.example'`), parsed(), obs);
    parseCodexEventLine(
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: `python3 upload.py --token ${secret}`, exit_code: 2, status: "completed" } }),
      parsed(),
      obs,
    );
    obs.finish("error");
    const joined = entries.join("\n");
    expect(joined).toContain("warn Sandbox declined shell:bash curl");
    expect(joined).toContain("error Tool failed shell:python3 upload.py (exit code 2)");
    expect(joined).not.toContain(secret);
    expect(joined).not.toContain("Authorization");
    expect(joined).not.toContain("internal.example");
    expect(joined).not.toContain("--token");
  });

  it("logs resume vs new session once, verified against the echoed thread id", () => {
    const resumed = make({ resumeThreadId: "thr-1" });
    parseCodexEventLine(lines[0]!, parsed(), resumed.obs);
    parseCodexEventLine(lines[0]!, parsed(), resumed.obs);
    expect(resumed.entries).toEqual(["info Codex session resumed"]);

    const fresh = make();
    parseCodexEventLine(lines[0]!, parsed(), fresh.obs);
    expect(fresh.entries).toEqual(["info New Codex session started"]);
  });

  it("#243: never claims a resume Codex did not echo — a silently fresh thread is a warn, not 'resumed'", () => {
    const mismatched = make({ resumeThreadId: "thr-previous" });
    parseCodexEventLine(lines[0]!, parsed(), mismatched.obs);
    expect(mismatched.entries).toEqual(["warn Codex resume requested but a new session was started"]);
  });

  it("logs the stream retry notice at most once and never the raw provider message", () => {
    const { entries, obs } = make();
    obs.onError("Reconnecting... 1/5 (Bearer leaked-in-error)");
    obs.onError("Reconnecting... 2/5");
    expect(entries).toEqual(["warn Codex stream reported a retryable error notice"]);
  });

  it("logs one warn per unavailable capability layer alongside the event", () => {
    const { entries, obs } = make();
    parseCodexEventLine(lines[0]!, parsed(), obs);
    obs.finish("ok");
    expect(entries.filter((line) => line.startsWith("warn"))).toEqual([
      "warn Capability layer unavailable: model",
      "warn Capability layer unavailable: tool",
    ]);
  });

  it("accumulates completion-summary counters across the stream", () => {
    const { obs } = make();
    const p = parsed();
    for (const line of lines) parseCodexEventLine(line, p, obs);
    obs.finish();
    // 2 shell commands + 1 file_change; the failing npm test is the one failure; two model calls (#230).
    expect(obs.stats()).toEqual({ modelCalls: 2, toolCalls: 3, toolFailures: 1, sandboxDenials: 0 });
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
  // Each fixture's reasoning text opens with its own phrase (#54: the 0.111 phrase asserted against
  // 0.142 was vacuously absent) — grep the fixture before changing a phrase here.
  it.each([
    ["codex-0.111.jsonl", "The task is simple"],
    ["codex-0.142.jsonl", "The user wants me to create"],
  ])(
    "%s maps one shell tool call and the turn usage",
    async (name, reasoningPhrase) => {
      const { events, obs } = await feed(name, "safe_summary");
      const types = events.map((e) => e.type);
      expect(obs.sessionId).toBeTruthy();
      expect(types.filter((t) => t.startsWith("tool.call.")).length).toBeGreaterThanOrEqual(1);
      expect(types).toContain("model.completed");
      expect(types).not.toContain("capability.unavailable");
      // Each capture is reasoning → command → message: the post-tool message is a second call (#230).
      expect(events.find((e) => e.type === "model.completed")!.attributes.modelCallsObserved).toBe(2);
      // E7/E8: reasoning text and the non-fatal notice never reach the store.
      expect(JSON.stringify(events)).not.toContain(reasoningPhrase);
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
    expect(events.find((event) => event.type === "capability.unavailable")).toMatchObject({
      attributes: { model: false, tool: true },
    });
    expect(types.filter((t) => t === "error.recorded")).toHaveLength(1);
    // trap 1: turn.failed nests its message under error.message.
    expect(p.errors.at(-1)).toContain("401 Unauthorized");
    expect(JSON.stringify(events)).not.toContain("Reconnecting... 1/5");
  });
});
