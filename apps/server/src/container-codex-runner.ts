import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { configuredModel, type AppConfig } from "./config.js";
import { buildCodexArgs, parseCodexEventLine } from "./codex-runner.js";
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

interface ActiveContainer {
  child: ChildProcess;
  containerName: string;
  cancelled: boolean;
  timedOut: boolean;
  outputExceeded: boolean;
  settled: Promise<void>;
  termination: Promise<void> | null;
  /** How the container was actually torn down — set from the real outcome of `rm --force`. */
  cleanup?: "rm --force" | "signal" | undefined;
}

interface ParsedEvents {
  messages: string[];
  threadId: string | null;
  usage: RunUsage | null;
  errors: string[];
}

export function containerName(agentId: string, instanceId = "default"): string {
  const safeInstance = instanceId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 32);
  const safeAgent = agentId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48);
  return "launchpad-" + safeInstance + "-" + safeAgent;
}

export function buildContainerRunArgs(
  request: RunnerRequest,
  config: AppConfig,
): string[] {
  const name = containerName(request.agentId, config.runtimeInstanceId);
  return [
    ...buildHardenedContainerPrefix({
      name,
      agentId: request.agentId,
      workspacePath: request.workspacePath,
      config,
      includeModelCredentials: true,
      mountCodexHome: true,
    }),
    config.containerRuntimeImage,
    "codex",
    ...buildCodexArgs(request, config.codexSandboxMode, "/workspace"),
  ];
}

export function buildHardenedContainerPrefix(options: {
  name: string;
  agentId: string;
  workspacePath: string;
  config: AppConfig;
  includeModelCredentials: boolean;
  mountCodexHome: boolean;
  /** Label value distinguishing per-Run runtime containers from long-lived previews (#96). */
  role?: "agent-runtime" | "agent-preview" | undefined;
  /** Serve-only containers (#96) get the workspace read-only; the Codex runtime keeps it writable. */
  workspaceReadOnly?: boolean | undefined;
}): string[] {
  const { name, agentId, workspacePath, config } = options;
  const engineName = config.containerEngine.split(/[\\/]/).at(-1)?.toLowerCase();
  return [
    "run",
    "--rm",
    "--init",
    "--name",
    name,
    "--label",
    "io.codejam.launchpad=" + (options.role ?? "agent-runtime"),
    "--label",
    "io.codejam.agent-id=" + agentId,
    "--label",
    "io.codejam.instance-id=" + config.runtimeInstanceId,
    ...(engineName === "podman" ? ["--userns", "keep-id"] : []),
    "--network",
    "bridge",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--cpus",
    String(config.containerCpuLimit),
    "--memory",
    config.containerMemoryLimit,
    "--pids-limit",
    String(config.containerPidsLimit),
    "--user",
    config.containerUser,
    ...(options.includeModelCredentials ? ["--env", "ARK_API_KEY", "--env", "OPENAI_API_KEY"] : []),
    ...(options.mountCodexHome ? ["--env", "CODEX_HOME=/codex-home"] : []),
    "--env",
    "HOME=/tmp",
    "--env",
    "NO_COLOR=1",
    "--mount",
    "type=bind,src=" + workspacePath + ",dst=/workspace" + (options.workspaceReadOnly ? ",readonly" : ""),
    ...(options.mountCodexHome ? ["--mount", "type=bind,src=" + config.codexHome + ",dst=/codex-home"] : []),
    "--workdir",
    "/workspace",
  ];
}

export class ContainerCodexRunner implements AgentRunner {
  private readonly active = new Map<string, ActiveContainer>();

  constructor(
    private readonly config: AppConfig,
    protected readonly emitter: ObservationEmitter = createDefaultEmitter(),
  ) {}

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.config.containerEngine, ["version"], {
        timeout: 5_000,
        env: this.childEnvironment(),
      });
      await execFileAsync(
        this.config.containerEngine,
        ["image", "inspect", this.config.containerRuntimeImage],
        { timeout: 5_000, env: this.childEnvironment() },
      );
      return true;
    } catch {
      return false;
    }
  }

  async cancel(agentId: string): Promise<boolean> {
    const active = this.active.get(agentId);
    if (!active) return false;

    active.cancelled = true;
    await this.removeContainer(active);
    await active.settled;
    return true;
  }

  private removeContainer(active: ActiveContainer): Promise<void> {
    if (!active.termination) {
      active.termination = execFileAsync(
        this.config.containerEngine,
        ["rm", "--force", active.containerName],
        { timeout: 8_000, env: this.childEnvironment() },
      )
        .then(() => { active.cleanup = "rm --force"; })
        .catch(() => {
          active.cleanup = "signal";
          active.child.kill("SIGTERM");
          const forceKill = setTimeout(() => active.child.kill("SIGKILL"), 3_000);
          forceKill.unref();
        });
    }
    return active.termination;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    if (this.active.has(request.agentId)) {
      throw new Error("Agent already has an active Runtime container");
    }

    const name = containerName(request.agentId, this.config.runtimeInstanceId);
    const timeoutMs = request.timeoutMs ?? this.config.codexTimeoutMs;
    const runtimeStartedAt = Date.now();
    const traceBase = request.trace
      ? {
          traceId: request.trace.traceId,
          runId: request.trace.runId,
          agentId: request.trace.agentId,
          ...RUNNER_ACTOR,
          source: { component: "AgentRunner", adapter: "ContainerCodexRunner", observed: true },
        }
      : undefined;
    // The container is the outer boundary; the codex process runs inside it.
    const containerSpan =
      traceBase && request.trace
        ? this.emitter.startSpan({
            ...traceBase,
            spanId: newId("spn"),
            parentSpanId: request.trace.parentSpanId,
            type: "runtime.container.started",
            category: "infrastructure",
            name: "container run",
            attributes: {
              engine: this.config.containerEngine,
              image: this.config.containerRuntimeImage,
              containerName: name,
              cpus: this.config.containerCpuLimit,
              memory: this.config.containerMemoryLimit,
              pids: this.config.containerPidsLimit,
            },
          })
        : undefined;
    const span =
      traceBase && containerSpan
        ? this.emitter.startSpan({
            ...traceBase,
            spanId: newId("spn"),
            parentSpanId: containerSpan.spanId,
            type: "runtime.codex.started",
            category: "runtime",
            name: "codex exec",
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
        ? new CodexStreamObserver(this.emitter, request.trace, span.spanId, "ContainerCodexRunner", {
            log: request.logger,
            resumeThreadId: request.threadId ?? undefined,
          })
        : undefined;
    const sink: CodexStreamSink | undefined = request.onActivity
      ? new CodexActivityTracker(request.onActivity, observer)
      : observer;

    const child = spawn(
      this.config.containerEngine,
      buildContainerRunArgs(request, this.config),
      {
        cwd: request.workspacePath,
        env: this.childEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    request.logger?.info(
      "Runner spawned: adapter=ContainerCodexRunner model=" + configuredModel(this.config) + " sandbox=" + this.config.codexSandboxMode,
    );
    const settled = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    const active: ActiveContainer = {
      child,
      containerName: name,
      cancelled: false,
      timedOut: false,
      outputExceeded: false,
      settled,
      termination: null,
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
        void this.removeContainer(active);
        return;
      }
      if (target === "stdout") {
        if (!firstOutputObserved && chunk.byteLength > 0) {
          firstOutputObserved = true;
          const latencyMs = Math.max(0, Date.now() - runtimeStartedAt);
          request.logger?.info("Codex first output after " + latencyMs + " ms");
          if (traceBase && span) {
            this.emitter.emit({
              ...traceBase, spanId: newId("spn"), parentSpanId: span.spanId,
              type: "runtime.codex.first_output", category: "runtime", name: "codex first output", status: "ok",
              attributes: { latencyMs },
            });
          }
        }
        stdout += chunk.toString("utf8");
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() ?? "";
        for (const line of lines) parseCodexEventLine(line, parsed, sink);
      } else {
        stderrBytes += chunk.byteLength;
        stderr += chunk.toString("utf8");
        if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, "stderr"));

    const timeout = setTimeout(() => {
      active.timedOut = true;
      void this.removeContainer(active);
    }, timeoutMs);
    timeout.unref();

    let spanEnded = false;
    /** Ends the codex span and its container wrapper together, so neither is left running. */
    const endSpans = (
      status: "ok" | "error" | "cancelled" | "timeout",
      error?: { type: string; message: string },
      extra: Record<string, string | number | boolean | null> = {},
    ) => {
      spanEnded = span !== undefined;
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
      const safeStderr = status !== "ok" && capturesSummaries(this.emitter.capturePolicy) && stderr.trim()
        ? redactText(stderr)
        : undefined;
      span?.end(status, {
        type: status === "ok" ? "runtime.codex.completed" : "runtime.codex.failed",
        attributes: { ...endAttrs, ...extra },
        ...(error ? { error } : {}),
        ...(safeStderr
          ? { summary: { text: safeStderr.text.slice(-2_048), policy: "safe_summary" as const }, preRedactedRules: safeStderr.rules }
          : {}),
      });
      // Only the container's own outcome (status/exitCode/cleanup) — the codex `error` belongs to the
      // codex span above, not to the container wrapper (#54).
      containerSpan?.end(status, {
        type: "runtime.container.stopped",
        attributes: {
          ...(child.exitCode !== null ? { exitCode: child.exitCode } : {}),
          ...(active.cleanup ? { cleanup: active.cleanup } : {}),
        },
      });
    };

    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      // The child can close before `rm --force` reports back; wait so the span records the real cleanup.
      if (active.termination) await active.termination;
      if (stdout.trim()) parseCodexEventLine(stdout.trim(), parsed, sink);
      const output = parsed.messages.at(-1)?.trim();
      const outcome = active.cancelled
        ? "cancelled"
        : active.timedOut
          ? "timeout"
          : active.outputExceeded || exitCode !== 0 || !output
            ? "error"
            : "ok";
      observer?.finish(outcome);
      if (active.cancelled) {
        endSpans("cancelled", { type: "cancelled", message: "Run cancelled" });
        throw new RunCancelledError();
      }
      if (active.timedOut) {
        const message = "Runtime timed out after " + timeoutMs + " ms";
        endSpans("timeout", { type: "timeout", message });
        throw new Error(message);
      }
      if (active.outputExceeded) {
        const message = "Codex output exceeded CODEX_MAX_OUTPUT_BYTES";
        if (traceBase && span) {
          this.emitter.emit({
            ...traceBase,
            spanId: newId("spn"),
            parentSpanId: span.spanId,
            type: "limit.exceeded",
            category: "runtime",
            name: "output_cap",
            status: "error",
            attributes: { limit: "CODEX_MAX_OUTPUT_BYTES", bytes: totalBytes },
          });
        }
        endSpans("error", { type: "output_cap", message });
        throw new Error(message);
      }
      if (exitCode !== 0) {
        // Bounded: see CodexRunner — an oversized error.message would quarantine the span end.
        const detail = parsed.errors.at(-1);
        const message = this.config.containerEngine + " Runtime exited with code " + exitCode + (detail ? ": " + detail.slice(0, 1024) : "");
        endSpans("error", { type: "exit_code", message });
        throw new Error(message);
      }
      if (!output) {
        const message = "Codex completed without an agent message";
        endSpans("error", { type: "no_output", message });
        throw new Error(message);
      }
      endSpans("ok", undefined, { outputBytes: Buffer.byteLength(output, "utf8") });
      return { output, threadId: parsed.threadId, usage: parsed.usage, ...(observer ? { stats: observer.stats() } : {}) };
    } catch (error) {
      // Only reached when the engine itself failed to spawn (the branches above end the spans).
      if (span && !spanEnded) {
        observer?.finish("error");
        endSpans("error", { type: "spawn_failed", message: String(error).slice(0, 2048) });
      }
      // No log line here: AgentService's catch writes the one "Runner failed/timed out after Ns" line
      // for every runner failure — a second line from the runner double-reported each failure (#243).
      throw error;
    } finally {
      clearTimeout(timeout);
      this.active.delete(request.agentId);
    }
  }

  private childEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
      ARK_API_KEY: this.config.arkApiKey,
      OPENAI_API_KEY: this.config.openaiApiKey,
      NO_COLOR: "1",
    };
    for (const name of [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "XDG_RUNTIME_DIR",
    ] as const) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return environment;
  }
}
