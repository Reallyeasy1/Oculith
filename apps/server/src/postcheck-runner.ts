import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import { buildHardenedContainerPrefix } from "./container-codex-runner.js";
import { createDefaultEmitter, type ObservationEmitter } from "./glassbox/emitter.js";
import { redactText } from "./glassbox/redact.js";
import { newId } from "./glassbox/schema.js";

const execFileAsync = promisify(execFile);

export interface PostCheckRequest {
  workspacePath: string;
  command: string;
  timeoutMs: number;
  trace?: { traceId: string; runId: string; agentId: string; parentSpanId: string } | undefined;
}

export interface PostCheckResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  stderrTail: string;
}

export function postCheckContainerName(): string {
  return "launchpad-postcheck-" + randomUUID().replaceAll("-", "").slice(0, 20);
}

export function buildPostCheckContainerArgs(request: PostCheckRequest, config: AppConfig, name: string): string[] {
  return [
    ...buildHardenedContainerPrefix({
      name,
      agentId: request.trace?.agentId ?? "postcheck",
      workspacePath: request.workspacePath,
      config,
      includeModelCredentials: false,
      mountCodexHome: false,
    }),
    config.containerRuntimeImage,
    "bash",
    "-lc",
    request.command,
  ];
}

function hostEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { NO_COLOR: "1" };
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "XDG_RUNTIME_DIR"] as const) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

export class PostCheckRunner {
  constructor(
    private readonly config: AppConfig,
    private readonly emitter: ObservationEmitter = createDefaultEmitter(),
  ) {}

  async run(request: PostCheckRequest): Promise<PostCheckResult> {
    const name = postCheckContainerName();
    const container = this.config.runtimeProvider === "container";
    const executable = container ? this.config.containerEngine : "bash";
    const args = container
      ? buildPostCheckContainerArgs(request, this.config, name)
      : ["-lc", request.command];
    const span = request.trace
      ? this.emitter.startSpan({
          ...request.trace,
          spanId: newId("spn"),
          type: "runtime.postcheck.started",
          category: "runtime",
          name: "post-check",
          source: { component: "PostCheckRunner", observed: true },
          attributes: { timeoutMs: request.timeoutMs, runtime: container ? "container" : "local-process" },
        })
      : undefined;
    const started = Date.now();
    const child = spawn(executable, args, {
      cwd: request.workspacePath,
      env: hostEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stderrTail = "";
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => { stdoutBytes += chunk.byteLength; });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2_048);
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      if (container) {
        void execFileAsync(this.config.containerEngine, ["rm", "--force", name], { timeout: 8_000, env: hostEnvironment() })
          .catch(() => child.kill("SIGTERM"));
      } else {
        child.kill("SIGTERM");
      }
    }, request.timeoutMs);
    timeout.unref();

    try {
      const outcome = await new Promise<{ code: number; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject);
        // 'exit', not 'close': a check that daemonizes a grandchild (sleep 600 &) exits immediately but
        // the orphan holds the stdio pipes open — 'close' would block the Run's completion path on it.
        // Byte counters are best-effort; a late flush after exit is lost, which is fine for metadata.
        child.once("exit", (code, signal) => resolve({ code: code ?? 1, signal }));
      });
      const durationMs = Date.now() - started;
      const result: PostCheckResult = {
        exitCode: outcome.code,
        signal: outcome.signal,
        durationMs,
        stdoutBytes,
        stderrBytes,
        stderrTail,
      };
      const status = timedOut ? "timeout" : outcome.code === 0 ? "ok" : "error";
      const safeTail = redactText(stderrTail).text.slice(-512);
      span?.end(status, {
        type: status === "ok" ? "runtime.postcheck.completed" : "runtime.postcheck.failed",
        attributes: { exitCode: outcome.code, durationMs, stdoutBytes, stderrBytes, ...(outcome.signal ? { signal: outcome.signal } : {}) },
        ...(this.emitter.capturePolicy === "safe_summary" && safeTail
          ? { summary: { text: safeTail, policy: "safe_summary" as const } }
          : {}),
      });
      return result;
    } catch (error) {
      span?.end("error", {
        type: "runtime.postcheck.failed",
        attributes: { durationMs: Date.now() - started, stdoutBytes, stderrBytes },
        error: { type: "spawn_failed", message: String(error).slice(0, 1_024) },
      });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
