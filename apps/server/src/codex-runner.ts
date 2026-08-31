import { execFile } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { configuredModel, type AppConfig } from "./config.js";
import { RunCancelledError } from "./errors.js";
import { CodexActivityTracker } from "./glassbox/activity.js";
import { CodexStreamObserver, RUNNER_ACTOR, type CodexStreamSink } from "./glassbox/codex-observer.js";
import { createDefaultEmitter, type ObservationEmitter } from "./glassbox/emitter.js";
import { capturesSummaries, newId } from "./glassbox/schema.js";
import { redactText } from "./glassbox/redact.js";
import type {
  AgentRunner,
  RunUsage,
  RunnerRequest,
  RunnerResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

export interface ParsedEvents {
  messages: string[];
  threadId: string | null;
  usage: RunUsage | null;
  errors: string[];
}

export function buildCodexArgs(
  request: RunnerRequest,
  sandboxMode: AppConfig["codexSandboxMode"],
  workspacePath = request.workspacePath,
): string[] {
  const args = [
    "exec",
    "--json",
    "--sandbox",
    sandboxMode,
    "--skip-git-repo-check",
    "-C",
    workspacePath,
  ];
  // "--" stops Codex (clap) flag parsing so a prompt like "--help" or "-C /" is a prompt, not a flag.
  if (request.threadId) {
    if (request.threadId.startsWith("-")) {
      throw new Error("Invalid Codex thread id");
    }
    args.push("resume", request.threadId, "--", request.prompt);
  } else {
    args.push("--", request.prompt);
  }
  return args;
}

export function parseCodexEventLine(
  line: string,
  parsed: ParsedEvents,
  sink?: CodexStreamSink,
): void {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    parsed.threadId = event.thread_id;
    sink?.onThreadStarted(event.thread_id);
  }

  if (event.type === "turn.started") {
    sink?.onTurnStarted();
  }

  if (event.type === "item.completed" && event.item && typeof event.item === "object") {
    const item = event.item as Record<string, unknown>;
    sink?.onItemCompleted(item);
    if (item.type === "agent_message" && typeof item.text === "string") {
      parsed.messages.push(item.text);
    }
  }

  if (event.type === "item.started" && event.item && typeof event.item === "object") {
    sink?.onItemStarted(event.item as Record<string, unknown>);
  }

  if (event.type === "turn.completed" && event.usage && typeof event.usage === "object") {
    const usage = event.usage as Record<string, unknown>;
    sink?.onTurnCompleted(usage);
    parsed.usage = {
      ...(typeof usage.input_tokens === "number"
        ? { inputTokens: usage.input_tokens }
        : {}),
      ...(typeof usage.cached_input_tokens === "number"
        ? { cachedInputTokens: usage.cached_input_tokens }
        : {}),
      ...(typeof usage.output_tokens === "number"
        ? { outputTokens: usage.output_tokens }
        : {}),
    };
  }

  // `error` lines are retry notices; `turn.failed` is the authoritative verdict and nests its
  // message under `error.message` (docs/CODEX_EVENTS.md trap 1). Both feed parsed.errors so the
  // runner can attach the last one to a failed span.
  if (event.type === "error" || event.type === "turn.failed") {
    const nested =
      event.error && typeof event.error === "object"
        ? (event.error as Record<string, unknown>).message
        : undefined;
    const message =
      typeof event.message === "string"
        ? event.message
        : typeof nested === "string"
          ? nested
          : typeof event.error === "string"
            ? event.error
            : "Codex reported an unknown error";
    parsed.errors.push(message);
    sink?.onError(message);
  }
}

export class CodexRunner implements AgentRunner {
  private readonly active = new Map<
    string,
    {
      child: ChildProcess;
      cancelled: boolean;
      timedOut: boolean;
      outputExceeded: boolean;
      settled: Promise<void>;
      forceKillTimer: NodeJS.Timeout | null;
    }
  >();

  constructor(
    private readonly config: AppConfig,
    protected readonly emitter: ObservationEmitter = createDefaultEmitter(),
  ) {}

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.config.codexBin, ["--version"], {
        timeout: 5_000,
        env: this.childEnvironment(),
      });
      return true;
    } catch {
      return false;
    }
  }

  async cancel(agentId: string): Promise<boolean> {
    const active = this.active.get(agentId);
    if (!active) {
      return false;
    }
    active.cancelled = true;
    this.terminate(active);
    await active.settled;
    return true;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    if (this.active.has(request.agentId)) {
      throw new Error("Agent already has an active Codex process");
    }

    const timeoutMs = request.timeoutMs ?? this.config.codexTimeoutMs;
    const runtimeStartedAt = Date.now();
    const span = request.trace
      ? this.emitter.startSpan({
          traceId: request.trace.traceId,
          runId: request.trace.runId,
          agentId: request.trace.agentId,
          spanId: newId("spn"),
          parentSpanId: request.trace.parentSpanId,
          ...RUNNER_ACTOR,
          type: "runtime.codex.started",
          category: "runtime",
          name: "codex exec",
          source: { component: "AgentRunner", adapter: "CodexRunner", observed: true },
          attributes: {
            sandbox: this.config.codexSandboxMode,
            resume: request.threadId !== null,
            timeoutMs,
            // An explicit per-request timeout only comes from the gated demo failure fixture.
            ...(request.timeoutMs !== undefined ? { demoFailure: "timeout" } : {}),
          },
        })
      : undefined;
    const observer =
      request.trace && span
        ? new CodexStreamObserver(this.emitter, request.trace, span.spanId, "CodexRunner", {
            log: request.logger,
            resumeThreadId: request.threadId ?? undefined,
          })
        : undefined;
    const sink: CodexStreamSink | undefined = request.onActivity
      ? new CodexActivityTracker(request.onActivity, observer)
      : observer;

    const args = buildCodexArgs(request, this.config.codexSandboxMode);
    const child = spawn(this.config.codexBin, args, {
      cwd: request.workspacePath,
      env: this.childEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    request.logger?.info(
      "Runner spawned: adapter=CodexRunner model=" + configuredModel(this.config) + " sandbox=" + this.config.codexSandboxMode,
    );
    const settled = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    const active = {
      child,
      cancelled: false,
      timedOut: false,
      outputExceeded: false,
      settled,
      forceKillTimer: null as NodeJS.Timeout | null,
    };
    this.active.set(request.agentId, active);

    const parsed: ParsedEvents = {
      messages: [],
      threadId: request.threadId,
      usage: null,
      errors: [],
    };
    let stdout = "";
    let stderr = "";
    let stderrBytes = 0;
    let totalBytes = 0;
    let firstOutputObserved = false;

    const consume = (chunk: Buffer, target: "stdout" | "stderr") => {
      totalBytes += chunk.byteLength;
      if (totalBytes > this.config.codexMaxOutputBytes) {
        active.outputExceeded = true;
        this.terminate(active);
        return;
      }
      if (target === "stdout") {
        if (!firstOutputObserved && chunk.byteLength > 0) {
          firstOutputObserved = true;
          const latencyMs = Math.max(0, Date.now() - runtimeStartedAt);
          request.logger?.info("Codex first output after " + latencyMs + " ms");
          if (request.trace && span) {
            this.emitter.emit({
              ...request.trace, spanId: newId("spn"), parentSpanId: span.spanId, ...RUNNER_ACTOR,
              type: "runtime.codex.first_output", category: "runtime", name: "codex first output", status: "ok",
              source: { component: "AgentRunner", adapter: "CodexRunner", observed: true },
              attributes: { latencyMs },
            });
          }
        }
        stdout += chunk.toString("utf8");
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() ?? "";
        for (const line of lines) {
          parseCodexEventLine(line, parsed, sink);
        }
      } else {
        stderrBytes += chunk.byteLength;
        stderr += chunk.toString("utf8");
        if (stderr.length > 16_384) {
          stderr = stderr.slice(-16_384);
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, "stderr"));

    const timeout = setTimeout(() => {
      active.timedOut = true;
      this.terminate(active);
    }, timeoutMs);
    timeout.unref();

    let spanEnded = false;
    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      if (stdout.trim()) {
        parseCodexEventLine(stdout.trim(), parsed, sink);
      }
      const output = parsed.messages.at(-1)?.trim();
      const outcome = active.cancelled
        ? "cancelled"
        : active.timedOut
          ? "timeout"
          : active.outputExceeded || exitCode !== 0 || !output
            ? "error"
            : "ok";
      observer?.finish(outcome);
      spanEnded = span !== undefined;
      // Observed only: the real exit code (null when a signal killed it) and the real signal.
      // `resumed` is the echo-verified sibling of the started event's intent-only `resume` attribute:
      // it compares the thread id Codex actually echoed against the one argv asked it to resume (#243).
      const endAttrs = {
        ...(child.exitCode !== null ? { exitCode: child.exitCode } : {}),
        ...(child.signalCode ? { terminationSignal: child.signalCode } : {}),
        ...(observer?.sessionId ? { sessionId: observer.sessionId } : {}),
        ...(request.threadId !== null && observer?.sessionId !== undefined
          ? { resumed: observer.sessionId === request.threadId }
          : {}),
        stderrBytes,
      };
      const safeStderr = capturesSummaries(this.emitter.capturePolicy) && stderr.trim() ? redactText(stderr) : undefined;
      const stderrSummary = safeStderr
        ? { summary: { text: safeStderr.text.slice(-2_048), policy: "safe_summary" as const }, preRedactedRules: safeStderr.rules }
        : {};
      if (active.cancelled) {
        span?.end("cancelled", {
          type: "runtime.codex.failed",
          attributes: endAttrs,
          error: { type: "cancelled", message: "Run cancelled" },
          ...stderrSummary,
        });
        throw new RunCancelledError();
      }
      if (active.timedOut) {
        const message = "Codex timed out after " + timeoutMs + " ms";
        span?.end("timeout", {
          type: "runtime.codex.failed",
          attributes: endAttrs,
          error: { type: "timeout", message },
          ...stderrSummary,
        });
        throw new Error(message);
      }
      if (active.outputExceeded) {
        const message = "Codex output exceeded CODEX_MAX_OUTPUT_BYTES";
        if (request.trace && span) {
          this.emitter.emit({
            traceId: request.trace.traceId,
            runId: request.trace.runId,
            agentId: request.trace.agentId,
            spanId: newId("spn"),
            parentSpanId: span.spanId,
            ...RUNNER_ACTOR,
            type: "limit.exceeded",
            category: "runtime",
            name: "output_cap",
            status: "error",
            source: { component: "AgentRunner", adapter: "CodexRunner", observed: true },
            attributes: { limit: "CODEX_MAX_OUTPUT_BYTES", bytes: totalBytes },
          });
        }
        span?.end("error", {
          type: "runtime.codex.failed",
          attributes: endAttrs,
          error: { type: "output_cap", message },
          ...stderrSummary,
        });
        throw new Error(message);
      }
      if (exitCode !== 0) {
        // Bounded: error.message is capped at 2048 by the schema — an oversized message would get the
        // whole span end quarantined. The structured codex error event is already redacted by redactEvent;
        // raw stderr is not a fallback here, it reaches the trace only as the safe_summary tail (#75).
        const detail = parsed.errors.at(-1);
        const message = "Codex exited with code " + exitCode + (detail ? ": " + detail.slice(0, 1024) : "");
        span?.end("error", {
          type: "runtime.codex.failed",
          attributes: endAttrs,
          error: { type: "exit_code", message },
          ...stderrSummary,
        });
        throw new Error(message);
      }
      if (!output) {
        const message = "Codex completed without an agent message";
        span?.end("error", {
          type: "runtime.codex.failed",
          attributes: endAttrs,
          error: { type: "no_output", message },
          ...stderrSummary,
        });
        throw new Error(message);
      }
      span?.end("ok", {
        type: "runtime.codex.completed",
        attributes: { ...endAttrs, outputBytes: Buffer.byteLength(output, "utf8") },
      });
      return {
        output,
        threadId: parsed.threadId,
        usage: parsed.usage,
        ...(observer ? { stats: observer.stats() } : {}),
      };
    } catch (error) {
      // Only reached when the spawn itself failed (the branches above end the span first).
      if (span && !spanEnded) {
        observer?.finish("error");
        span.end("error", {
          type: "runtime.codex.failed",
          error: { type: "spawn_failed", message: String(error).slice(0, 2048) },
        });
      }
      // No log line here: AgentService's catch writes the one "Runner failed/timed out after Ns" line
      // for every runner failure — a second line from the runner double-reported each failure (#243).
      throw error;
    } finally {
      clearTimeout(timeout);
      if (active.forceKillTimer) clearTimeout(active.forceKillTimer);
      this.active.delete(request.agentId);
    }
  }

  private terminate(active: {
    child: ChildProcess;
    forceKillTimer: NodeJS.Timeout | null;
  }): void {
    if (active.child.exitCode !== null || active.child.signalCode !== null) return;
    active.child.kill("SIGTERM");
    if (!active.forceKillTimer) {
      active.forceKillTimer = setTimeout(() => active.child.kill("SIGKILL"), 3_000);
      active.forceKillTimer.unref();
    }
  }

  private childEnvironment(): NodeJS.ProcessEnv {
    const inheritedNames = [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "TERM",
    ] as const;
    const environment: NodeJS.ProcessEnv = {
      CODEX_HOME: this.config.codexHome,
      ARK_API_KEY: this.config.arkApiKey,
      OPENAI_API_KEY: this.config.openaiApiKey,
      NO_COLOR: "1",
    };
    for (const name of inheritedNames) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return environment;
  }
}
