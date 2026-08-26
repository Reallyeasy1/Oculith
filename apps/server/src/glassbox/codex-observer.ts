import type { RunnerTraceContext } from "../types.js";
import type { ObservationEmitter } from "./emitter.js";
import { newId, type EventInput, type EventType } from "./schema.js";

/** What `parseCodexEventLine` reports while it walks a `codex exec --json` stream.
 * Every hook is optional work for the parser's existing callers — the sink argument is optional. */
export interface CodexStreamSink {
  onThreadStarted(threadId: string): void;
  onItemCompleted(item: Record<string, unknown>): void;
  onTurnCompleted(usage: Record<string, unknown>): void;
  onError(message: string): void;
}

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const bytes = (v: unknown): number => Buffer.byteLength(str(v) ?? "", "utf8");

const USAGE_KEYS: Record<string, string> = {
  input_tokens: "inputTokens",
  cached_input_tokens: "cachedInputTokens",
  output_tokens: "outputTokens",
  reasoning_output_tokens: "reasoningOutputTokens",
};

/**
 * Turns an observed Codex event stream into ObservationEvents. Mapping is pinned to the captures
 * catalogued in `docs/CODEX_EVENTS.md` — nothing here is inferred from a schema we have not seen:
 *  - `reasoning` items are never captured (no chain-of-thought, deliberately unmapped, E7).
 *  - an `item.type === "error"` is a non-fatal notice on every Ark run (E8) and is dropped.
 *  - top-level `error` lines are retry noise (E11); the last one is buffered and only surfaces as a
 *    single `error.recorded` when the run itself fails.
 *  - `file_change` has never been observed (Ark shells out instead of calling apply_patch), so the
 *    branch below is defensive only; a real workspace diff is the honest source for `workspace.changed`.
 */
export class CodexStreamObserver implements CodexStreamSink {
  sessionId: string | undefined;
  private sawTool = false;
  private sawModel = false;
  private finished = false;
  private lastError: string | undefined;

  constructor(
    private readonly emitter: ObservationEmitter,
    private readonly trace: RunnerTraceContext,
    private readonly parentSpanId: string,
    private readonly adapter: "CodexRunner" | "ContainerCodexRunner",
  ) {}

  private base(type: EventType, name: string): Omit<EventInput, "category"> {
    return {
      traceId: this.trace.traceId,
      runId: this.trace.runId,
      agentId: this.trace.agentId,
      spanId: newId("spn"),
      parentSpanId: this.parentSpanId,
      type,
      name,
      source: { component: "AgentRunner", adapter: this.adapter, observed: true },
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
    };
  }

  onThreadStarted(threadId: string): void {
    this.sessionId = threadId;
  }

  onItemCompleted(item: Record<string, unknown>): void {
    const kind = str(item.type);
    if (kind === "command_execution") {
      this.commandExecution(item);
    } else if (kind === "file_change" && Array.isArray(item.changes)) {
      this.fileChange(item.changes as Array<Record<string, unknown>>);
    } else if (kind === "mcp_tool_call" || kind === "web_search") {
      this.sawTool = true;
      this.emitter.emit({
        ...this.base("tool.call.completed", kind),
        category: "tool",
        status: str(item.status) === "failed" ? "error" : "ok",
        attributes: { tool: kind },
      });
    }
    // agent_message: the runner's final output, not trace content.
    // reasoning: deliberately never captured. error: non-fatal notice (E8), not a failure.
  }

  private commandExecution(item: Record<string, unknown>): void {
    this.sawTool = true;
    const command = str(item.command) ?? "";
    // exit_code is null while in progress (E3) and -1 when the sandbox declines (E5): a truthiness
    // check would misclassify both. null stays unknown, -1 is a failure.
    const exitCode = num(item.exit_code);
    const declined = str(item.status) === "declined";
    const failed = declined || (exitCode !== undefined && exitCode !== 0);
    const program = (command.trim().split(/\s+/)[0] ?? "").slice(0, 40);
    this.emitter.emit({
      ...this.base(failed ? "tool.call.failed" : "tool.call.completed", "shell:" + program),
      category: "tool",
      status: failed ? "error" : "ok",
      // Metadata only: the command text itself is content and goes in the summary, under policy.
      attributes: {
        program,
        commandBytes: Buffer.byteLength(command, "utf8"),
        ...(exitCode !== undefined ? { exitCode } : {}),
        outputBytes: bytes(item.aggregated_output),
      },
      ...(this.emitter.capturePolicy === "safe_summary"
        ? { summary: { text: command.slice(0, 512), policy: "safe_summary" as const } }
        : {}),
      ...(failed
        ? {
            error: declined
              ? { type: "denied", message: "Command declined by the sandbox policy" }
              : { type: "exit_code", message: "exit code " + String(exitCode) },
          }
        : {}),
    });
  }

  private fileChange(changes: Array<Record<string, unknown>>): void {
    const count = (kind: string) => changes.filter((c) => str(c.kind) === kind).length;
    this.emitter.emit({
      ...this.base("workspace.changed", "workspace.changed"),
      category: "workspace",
      status: "ok",
      attributes: {
        fileCount: changes.length,
        added: count("add"),
        updated: count("update"),
        deleted: count("delete"),
      },
      ...(this.emitter.capturePolicy === "safe_summary"
        ? {
            summary: {
              text: changes.map((c) => str(c.path) ?? "?").slice(0, 20).join(", "),
              policy: "safe_summary" as const,
            },
          }
        : {}),
    });
  }

  onTurnCompleted(usage: Record<string, unknown>): void {
    this.sawModel = true;
    // Usage keys differ across Codex versions (E9 has no reasoning_output_tokens, E10 does), so
    // every field is optional and only the ones actually present are recorded.
    const attributes: Record<string, number> = {};
    for (const [from, to] of Object.entries(USAGE_KEYS)) {
      const value = num(usage[from]);
      if (value !== undefined) attributes[to] = value;
    }
    this.emitter.emit({
      ...this.base("model.completed", "model.completed"),
      category: "model",
      status: "ok",
      attributes,
    });
  }

  /** Buffers only: a stream `error` line is a retry notice until the run actually fails (trap 3). */
  onError(message: string): void {
    this.lastError = message;
  }

  /** Call once when the stream is done, with the run's real outcome. A non-`ok` outcome releases the
   * buffered stream error as one event. `capability.unavailable` is only honest for a run that ran to
   * its own conclusion: a cancelled or timed-out stream was cut short, so the absence of tool/model
   * evidence says nothing about what the runtime exposes (invariant 3 — never fabricate evidence). */
  finish(outcome: "ok" | "error" | "cancelled" | "timeout" = "ok"): void {
    if (this.finished) return;
    this.finished = true;
    if (outcome !== "ok" && this.lastError) {
      this.emitter.emit({
        ...this.base("error.recorded", "codex.error"),
        category: "runtime",
        status: "error",
        error: { type: "codex_error", message: this.lastError.slice(0, 2048) },
      });
    }
    if (!this.sawTool && !this.sawModel && (outcome === "ok" || outcome === "error")) {
      this.emitter.emit({
        ...this.base("capability.unavailable", "capability.unavailable"),
        category: "runtime",
        status: "unset",
        attributes: { model: false, tool: false },
      });
    }
  }
}
