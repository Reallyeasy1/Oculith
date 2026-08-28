import path from "node:path";
import type { RunnerLogger, RunnerRunStats, RunnerTraceContext } from "../types.js";
import type { ObservationEmitter } from "./emitter.js";
import { redactText } from "./redact.js";
import { capturesSummaries, newId, type EventInput, type EventType } from "./schema.js";

/** What `parseCodexEventLine` reports while it walks a `codex exec --json` stream.
 * Every hook is optional work for the parser's existing callers — the sink argument is optional. */
export interface CodexStreamSink {
  onThreadStarted(threadId: string): void;
  onTurnStarted(): void;
  onItemStarted(item: Record<string, unknown>): void;
  onItemCompleted(item: Record<string, unknown>): void;
  onTurnCompleted(usage: Record<string, unknown>): void;
  onError(message: string): void;
}

/** Runtime/container lifecycle is the runner's own doing, not the user's and not the agent's. */
export const RUNNER_ACTOR = { actorId: "runner", actorType: "service" } as const;

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const bytes = (v: unknown): number => Buffer.byteLength(str(v) ?? "", "utf8");

const REPORTED_FAILURE_PHRASES = ["not installed", "could not", "unable to", "failed to", "permission denied"] as const;

/** Bounded, deterministic outcome metadata. Callers may discard `text` immediately after this returns. */
export function describeFinalMessage(text: string): { finalMessageBytes: number; reportedFailure: boolean; summaryText: string } {
  const normalized = text.toLocaleLowerCase("en-US");
  return {
    finalMessageBytes: Buffer.byteLength(text, "utf8"),
    reportedFailure: REPORTED_FAILURE_PHRASES.some((phrase) => normalized.includes(phrase)),
    summaryText: text.slice(0, 240),
  };
}

/** Bounded identity (#130): basename of the program plus its first argument, 64 chars max. Codex wraps every
 * command as `/bin/bash -lc '<script>'` (E3/E4) or `powershell.exe -Command "<script>"` (E5), so the first
 * argument of a shell wrapper is the script's own first token — `bash python3`, not `bash -lc`. */
export function commandIdentity(command: string): { program: string } | { program: string; argument0: string } {
  const tokenize = (text: string): string[] => text.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const unquote = (token: string): string => token.replace(/^(?:"|')|(?:"|')$/g, "");
  const tokens = tokenize(command);
  const program = path.win32.basename(unquote(tokens[0] ?? "")).slice(0, 40);
  const script = /^-(?:l?c|Command)$/i.test(tokens[1] ?? "") && tokens[2] ? tokenize(unquote(tokens[2]))[0] : undefined;
  const argument0 = (script ?? (tokens[1] ? unquote(tokens[1]) : undefined))?.slice(0, 64);
  return { program, ...(argument0 ? { argument0 } : {}) };
}

const USAGE_KEYS: Record<string, string> = {
  input_tokens: "inputTokens",
  cached_input_tokens: "cachedInputTokens",
  output_tokens: "outputTokens",
  reasoning_output_tokens: "reasoningOutputTokens",
};

/**
 * Turns an observed Codex event stream into ObservationEvents. Mapping is pinned to the captures
 * catalogued in `docs/CODEX_EVENTS.md` — nothing here is inferred from a schema we have not seen:
 *  - `reasoning` item text is never captured raw. Its count is always kept, as a per-turn model-call
 *    proxy (#207) — codex exec emits exactly one turn per prompt, so the turn span alone cannot
 *    distinguish one model call from many. Under the explicit opt-in `reasoning_summary` policy ONLY
 *    (#259), each item additionally emits a `model.reasoning` event with a 240-char redacted summary.
 *  - an `item.type === "error"` is a non-fatal notice on every Ark run (E8) and is dropped.
 *  - top-level `error` lines are retry noise (E11); the last one is buffered and only surfaces as a
 *    single `error.recorded` when the run itself fails.
 *  - `file_change` is emitted when the model uses apply_patch (observed with deepseek-v4-flash on 2026-08-27); it
 *    reports { fileCount, added, updated, deleted } only. The platform's disk snapshot (AgentService, adapter
 *    WorkspaceSnapshot) is the honest source for `workspace.changed`; buildTrace prefers it over this report.
 */
/** After this many individual denial log lines in a Run, further denials are coalesced. */
const DENIAL_LOG_LIMIT = 5;
/** One coalesced summary line per this many further denials. */
const DENIAL_LOG_BATCH = 10;

export class CodexStreamObserver implements CodexStreamSink {
  sessionId: string | undefined;
  private sawAnyEvent = false;
  private sawTool = false;
  private sawModel = false;
  private finished = false;
  private lastError: string | undefined;
  private retryNoticeLogged = false;
  private turnIndex = 0;
  private activeTurn: { spanId: string; turnIndex: number } | undefined;
  private observedCalls = 0;
  private unpairedReasoning = 0;
  private readonly totals: RunnerRunStats = { modelCalls: 0, toolCalls: 0, toolFailures: 0, sandboxDenials: 0 };
  private readonly activeItems = new Map<string, { spanId: string; kind: string }>();

  constructor(
    private readonly emitter: ObservationEmitter,
    private readonly trace: RunnerTraceContext,
    private readonly parentSpanId: string,
    private readonly adapter: "CodexRunner" | "ContainerCodexRunner",
    /** Optional per-Run log sink (#232). Lines carry only the bounded identities computed here —
     * never raw command text, message content, or chain-of-thought (invariants 1/3/5). */
    private readonly options: { log?: RunnerLogger | undefined; resume?: boolean | undefined } = {},
  ) {}

  /** Bounded counters observed so far; returned on RunnerResult for the completion-summary line. */
  stats(): RunnerRunStats {
    return { ...this.totals };
  }

  private base(type: EventType, name: string, spanId = newId("spn")): Omit<EventInput, "category"> {
    return {
      traceId: this.trace.traceId,
      runId: this.trace.runId,
      agentId: this.trace.agentId,
      spanId,
      parentSpanId: this.parentSpanId,
      type,
      name,
      // Everything the stream reports is the agent acting (tool, model, workspace); the runtime notices
      // in finish() and the sandbox denial override this.
      actorId: this.trace.agentId,
      actorType: "agent",
      source: { component: "AgentRunner", adapter: this.adapter, observed: true },
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
    };
  }

  onThreadStarted(threadId: string): void {
    this.sawAnyEvent = true;
    const first = this.sessionId === undefined;
    this.sessionId = threadId;
    // The thread id resolving is the moment we know whether Codex resumed or started fresh.
    if (first) this.options.log?.info(this.options.resume ? "Codex session resumed" : "New Codex session started");
  }

  onTurnStarted(): void {
    this.sawAnyEvent = true;
    this.sawModel = true;
    // A turn abandoned without turn.completed (E12 turn.failed) must not donate its item count to the
    // next turn — buildTrace already floors the abandoned span at one call. Items seen before any
    // turn.started (out-of-order streams) still belong to the turn that is opening now.
    if (this.activeTurn) {
      this.observedCalls = 0;
      this.unpairedReasoning = 0;
    }
    const turn = { spanId: newId("spn"), turnIndex: ++this.turnIndex };
    this.activeTurn = turn;
    this.emitter.emit({
      ...this.base("model.request", "model.turn", turn.spanId),
      category: "model",
      phase: "start",
      status: "running",
      attributes: { turnIndex: turn.turnIndex },
    });
  }

  onItemStarted(item: Record<string, unknown>): void {
    const kind = str(item.type);
    if (!kind || !["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(kind)) return;
    this.sawAnyEvent = true;
    this.sawTool = true;
    const spanId = newId("spn");
    const id = str(item.id);
    if (id) this.activeItems.set(id, { spanId, kind });
    const command = str(item.command) ?? "";
    const identity = kind === "command_execution" ? commandIdentity(command) : undefined;
    this.emitter.emit({
      ...this.base("tool.call.started", identity ? "shell:" + identity.program : kind, spanId),
      category: "tool",
      phase: "start",
      status: "running",
      attributes: identity
        ? { ...identity, commandBytes: Buffer.byteLength(command, "utf8") }
        : { tool: kind },
    });
  }

  onItemCompleted(item: Record<string, unknown>): void {
    this.sawAnyEvent = true;
    const kind = str(item.type);
    if (kind === "reasoning") {
      // Each reasoning item is one model call (#207). Counting comes first and is policy-independent.
      this.observedCalls++;
      this.unpairedReasoning++;
      // #259: reasoning text is captured ONLY under the explicit opt-in reasoning_summary tier — never
      // under safe_summary or metadata_only — as a bounded redacted summary, redacted BEFORE the slice
      // (the #258 rule: a cut can drop the anchor a pattern needs and leak the bare token). Mirrors
      // model.message below.
      if (this.emitter.capturePolicy === "reasoning_summary") {
        const text = str(item.text) ?? "";
        this.emitter.emit({
          ...this.base("model.reasoning", "model.reasoning"),
          category: "model",
          status: "ok",
          attributes: { reasoningBytes: Buffer.byteLength(text, "utf8") },
          summary: { text: redactText(text).text.slice(0, 240), policy: "safe_summary" },
        });
      }
    } else if (kind === "agent_message") {
      // A message produced by the same call as its reasoning is not a second call; without one
      // (non-reasoning models) the message is the only evidence the call happened.
      if (this.unpairedReasoning > 0) this.unpairedReasoning--;
      else this.observedCalls++;
      // #258: every agent message (not just the final one) is captured as a bounded summary — but only
      // under a summary-capturing policy. Its sole payload is content, so at metadata_only the event is
      // not emitted at all (an empty shell would carry nothing an operator can use). Counting above is
      // policy-independent.
      if (capturesSummaries(this.emitter.capturePolicy)) {
        const text = str(item.text) ?? "";
        this.emitter.emit({
          ...this.base("model.message", "model.message"),
          category: "model",
          status: "ok",
          attributes: { messageBytes: Buffer.byteLength(text, "utf8") },
          summary: { text: redactText(text).text.slice(0, 240), policy: "safe_summary" },
        });
      }
    }
    if (kind && ["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(kind)) {
      // A message emitted after a tool result must come from a later model call — the model had to
      // see the tool output to produce it — so a pre-tool reasoning item can no longer absorb it.
      this.unpairedReasoning = 0;
    }
    if (kind === "command_execution") {
      this.commandExecution(item);
    } else if (kind === "file_change") {
      this.completeGenericTool(item, kind);
      if (Array.isArray(item.changes)) this.fileChange(item.changes as Array<Record<string, unknown>>);
    } else if (kind === "mcp_tool_call" || kind === "web_search") {
      this.completeGenericTool(item, kind);
    }
    // reasoning: raw text never captured; counted above, summarised only under reasoning_summary (#259).
    // error: non-fatal notice (E8), not a failure.
  }

  /** #258: last 512 chars of `aggregated_output`, appended to tool summaries under summary-capturing policies only.
   * Redacted BEFORE slicing (same as the runner's stderr tail): a tail cut can drop the `Bearer `/key
   * prefix a pattern anchors on and leak the bare token. The emitter's redactEvent scans it again. */
  private outputTail(item: Record<string, unknown>): string | undefined {
    const output = str(item.aggregated_output);
    return output ? redactText(output).text.slice(-512) : undefined;
  }

  /** "shell:powershell.exe Get-ChildItem" — the same bounded identity the trace stores, nothing more. */
  private identityLabel(identity: ReturnType<typeof commandIdentity>): string {
    return "shell:" + identity.program + ("argument0" in identity ? " " + identity.argument0 : "");
  }

  private logDenial(identity: ReturnType<typeof commandIdentity>): void {
    const count = ++this.totals.sandboxDenials;
    // Coalesce bursts: the first DENIAL_LOG_LIMIT denials get one line each; after that, one summary
    // line per DENIAL_LOG_BATCH further denials, so a denial storm cannot flood the log sink.
    if (count <= DENIAL_LOG_LIMIT) {
      this.options.log?.warn("Sandbox declined " + this.identityLabel(identity));
    } else if ((count - DENIAL_LOG_LIMIT) % DENIAL_LOG_BATCH === 0) {
      this.options.log?.warn(DENIAL_LOG_BATCH + " more sandbox denials (" + count + " total)");
    }
  }

  private commandExecution(item: Record<string, unknown>): void {
    this.sawTool = true;
    const command = str(item.command) ?? "";
    // exit_code is null while in progress (E3) and -1 when the sandbox declines (E5): a truthiness
    // check would misclassify both. null stays unknown, -1 is a failure.
    const exitCode = num(item.exit_code);
    const declined = str(item.status) === "declined";
    const failed = declined || (exitCode !== undefined && exitCode !== 0);
    // win32.basename strips both "/" and "\\" on every platform, so an absolute exe path (which on
    // Windows carries the user profile) never reaches the store.
    const identity = commandIdentity(command);
    const active = str(item.id) ? this.activeItems.get(str(item.id)!) : undefined;
    if (str(item.id)) this.activeItems.delete(str(item.id)!);
    const tail = capturesSummaries(this.emitter.capturePolicy) ? this.outputTail(item) : undefined;
    this.totals.toolCalls++;
    if (failed) this.totals.toolFailures++;
    if (declined) this.logDenial(identity);
    else if (failed) this.options.log?.error("Tool failed " + this.identityLabel(identity) + " (exit code " + String(exitCode) + ")");
    this.emitter.emit({
      ...this.base(failed ? "tool.call.failed" : "tool.call.completed", "shell:" + identity.program, active?.spanId),
      category: "tool",
      ...(active ? { phase: "end" as const } : {}),
      status: failed ? "error" : "ok",
      // Metadata only: the command text itself is content and goes in the summary, under policy.
      attributes: {
        ...identity,
        commandBytes: Buffer.byteLength(command, "utf8"),
        ...(exitCode !== undefined ? { exitCode } : {}),
        outputBytes: bytes(item.aggregated_output),
      },
      // #258: command text (1024) plus a redacted tail of the output — for failed tools this is the
      // error text the operator previously never saw. Bounded well under the 4096 summary cap.
      ...(capturesSummaries(this.emitter.capturePolicy)
        ? {
            summary: {
              text: command.slice(0, 1024) + (tail !== undefined ? "\n--- output tail ---\n" + tail : ""),
              policy: "safe_summary" as const,
            },
          }
        : {}),
      ...(failed
        ? {
            error: declined
              ? { type: "denied", message: "Command declined by the sandbox policy" }
              : { type: "exit_code", message: "exit code " + String(exitCode) },
          }
        : {}),
    });
    if (declined) {
      // Keep this separate from tool.call.failed: consumers need to distinguish a sandbox policy
      // decision from an ordinary non-zero exit. Only bounded metadata is captured here.
      this.emitter.emit({
        ...this.base("policy.denied", identity.program || "shell"),
        category: "policy",
        status: "error",
        actorId: "sandbox",
        actorType: "service",
        source: { component: "Sandbox", adapter: this.adapter, observed: true },
        attributes: { ...identity, decision: "sandbox_declined", commandBytes: Buffer.byteLength(command, "utf8") },
      });
    }
  }

  private completeGenericTool(item: Record<string, unknown>, kind: string): void {
    this.sawTool = true;
    const tail = capturesSummaries(this.emitter.capturePolicy) ? this.outputTail(item) : undefined;
    const id = str(item.id);
    const active = id ? this.activeItems.get(id) : undefined;
    if (id) this.activeItems.delete(id);
    const failed = str(item.status) === "failed" || str(item.status) === "declined";
    this.totals.toolCalls++;
    if (failed) {
      this.totals.toolFailures++;
      this.options.log?.error("Tool failed " + kind);
    }
    this.emitter.emit({
      ...this.base(failed ? "tool.call.failed" : "tool.call.completed", kind, active?.spanId),
      category: "tool",
      ...(active ? { phase: "end" as const } : {}),
      status: failed ? "error" : "ok",
      attributes: { tool: kind },
      // #258: when the stream reported output for this tool, keep its redacted tail under safe_summary.
      ...(tail !== undefined ? { summary: { text: tail, policy: "safe_summary" as const } } : {}),
      ...(failed ? { error: { type: "tool_failed", message: kind + " failed" } } : {}),
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
      ...(capturesSummaries(this.emitter.capturePolicy)
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
    this.sawAnyEvent = true;
    this.sawModel = true;
    // Usage keys differ across Codex versions (E9 has no reasoning_output_tokens, E10 does), so
    // every field is optional and only the ones actually present are recorded.
    const attributes: Record<string, number> = {};
    for (const [from, to] of Object.entries(USAGE_KEYS)) {
      const value = num(usage[from]);
      if (value !== undefined) attributes[to] = value;
    }
    const turn = this.activeTurn ?? { spanId: newId("spn"), turnIndex: ++this.turnIndex };
    this.emitter.emit({
      ...this.base("model.completed", "model.turn", turn.spanId),
      category: "model",
      ...(this.activeTurn ? { phase: "end" as const } : {}),
      status: "ok",
      // modelCallsObserved (#207) is the count of reasoning/agent_message items seen this turn; when no
      // item evidence arrived it is omitted rather than guessed (buildTrace floors the turn at one call).
      attributes: {
        turnIndex: turn.turnIndex,
        ...(this.observedCalls > 0 ? { modelCallsObserved: this.observedCalls } : {}),
        ...attributes,
      },
    });
    // Completion-summary counter: a completed turn is at least one model call (the same floor
    // buildTrace applies when no item evidence arrived). ponytail: an abandoned turn adds nothing.
    this.totals.modelCalls += this.observedCalls > 0 ? this.observedCalls : 1;
    this.activeTurn = undefined;
    this.observedCalls = 0;
    this.unpairedReasoning = 0;
  }

  /** Buffers only: a stream `error` line is a retry notice until the run actually fails (trap 3). */
  onError(message: string): void {
    this.sawAnyEvent = true;
    this.lastError = message;
    // Metadata-only notice, at most once per Run: the raw provider message stays out of the log.
    if (!this.retryNoticeLogged) {
      this.retryNoticeLogged = true;
      this.options.log?.warn("Codex stream reported a retryable error notice");
    }
  }

  /** Call once when the stream is done, with the run's real outcome. A non-`ok` outcome releases the
   * buffered stream error as one event. `capability.unavailable` is only honest for a run that ran to
   * its own conclusion: a cancelled or timed-out stream was cut short, so the absence of tool/model
   * evidence says nothing about what the runtime exposes (invariant 3 — never fabricate evidence).
   * Likewise a stream that produced nothing at all (spawn failure, output-cap abort before the first
   * line) is no evidence about capabilities either. */
  finish(outcome: "ok" | "error" | "cancelled" | "timeout" = "ok"): void {
    if (this.finished) return;
    this.finished = true;
    if (outcome !== "ok" && this.lastError) {
      this.emitter.emit({
        ...this.base("error.recorded", "codex.error"),
        ...RUNNER_ACTOR,
        category: "runtime",
        status: "error",
        error: { type: "codex_error", message: this.lastError.slice(0, 2048) },
      });
    }
    if (this.sawAnyEvent && (!this.sawTool || !this.sawModel) && (outcome === "ok" || outcome === "error")) {
      this.emitter.emit({
        ...this.base("capability.unavailable", "capability.unavailable"),
        ...RUNNER_ACTOR,
        category: "runtime",
        status: "unset",
        attributes: { model: !this.sawModel, tool: !this.sawTool },
      });
      if (!this.sawModel) this.options.log?.warn("Capability layer unavailable: model");
      if (!this.sawTool) this.options.log?.warn("Capability layer unavailable: tool");
    }
  }
}
