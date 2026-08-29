import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { buildHardenedContainerPrefix } from "./container-codex-runner.js";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import { createDefaultEmitter, type ObservationEmitter } from "./glassbox/emitter.js";
import { redactText } from "./glassbox/redact.js";
import { newId } from "./glassbox/schema.js";
import type { PreviewCommand, WorkspacePreview } from "./types.js";

const execFileAsync = promisify(execFile);

/** Fixed port inside the container; the host side comes from PREVIEW_PORT_RANGE. */
export const PREVIEW_CONTAINER_PORT = 5173;

// No package install at start time: a workspace without a local vite fails fast instead of pulling
// from the network, and the static server is a stdlib one-liner so it needs nothing at all.
const STATIC_SERVER_SCRIPT = [
  'const http=require("http"),fs=require("fs"),path=require("path");',
  'const root=path.resolve("/workspace/dist");',
  'const types={".html":"text/html",".js":"text/javascript",".mjs":"text/javascript",".css":"text/css",".json":"application/json",".map":"application/json",".svg":"image/svg+xml",".png":"image/png",".jpg":"image/jpeg",".ico":"image/x-icon",".txt":"text/plain",".woff2":"font/woff2"};',
  "http.createServer((req,res)=>{",
  'let file=path.normalize(path.join(root,decodeURIComponent((req.url||"/").split("?")[0])));',
  "if(file!==root&&!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return}",
  'try{if(fs.statSync(file).isDirectory())file=path.join(file,"index.html")}catch{}',
  "fs.readFile(file,(err,data)=>{",
  'if(err){res.writeHead(404);res.end("Not found");return}',
  'res.writeHead(200,{"content-type":types[path.extname(file).toLowerCase()]||"application/octet-stream"});',
  "res.end(data)})",
  `}).listen(${PREVIEW_CONTAINER_PORT},"0.0.0.0");`,
].join("");

export const PREVIEW_COMMANDS: Record<PreviewCommand, string[]> = {
  vite: ["npx", "--no-install", "vite", "preview", "--host", "0.0.0.0", "--port", String(PREVIEW_CONTAINER_PORT), "--strictPort"],
  static: ["node", "-e", STATIC_SERVER_SCRIPT],
};

export type PreviewStopReason = "user_request" | "ttl_expired" | "agent_deleted" | "stale_cleanup" | "exited";

/** Retry cadence after the engine failed to confirm a removal (e.g. daemon restarting). */
const REMOVE_RETRY_MS = 60_000;
/** The engine saying the container does not exist IS a confirmed removal (`--rm` already took it). */
const CONTAINER_GONE = /no such (object|container)/i;

/** Injectable so tests never spawn a real engine; the default shells out to `config.containerEngine`. */
export interface PreviewEngine {
  exec(args: string[], timeoutMs?: number): Promise<{ stdout: string; stderr: string }>;
}

export function previewContainerName(agentId: string, instanceId = "default"): string {
  const safeInstance = instanceId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 32);
  const safeAgent = agentId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48);
  return "launchpad-preview-" + safeInstance + "-" + safeAgent;
}

export function buildPreviewContainerArgs(options: {
  config: AppConfig;
  agentId: string;
  workspacePath: string;
  port: number;
  command: PreviewCommand;
  previewId: string;
  traceId: string;
  spanId: string;
}): string[] {
  const { config } = options;
  return [
    ...buildHardenedContainerPrefix({
      name: previewContainerName(options.agentId, config.runtimeInstanceId),
      agentId: options.agentId,
      workspacePath: options.workspacePath,
      config,
      // The preview only serves files: no model credentials, no Codex session store, and the
      // workspace mount is read-only — nothing in a serve-only container may write it.
      includeModelCredentials: false,
      mountCodexHome: false,
      workspaceReadOnly: true,
      role: "agent-preview",
    }),
    "--detach",
    // Loopback only: the preview is for the local operator, not the network.
    "--publish", "127.0.0.1:" + options.port + ":" + PREVIEW_CONTAINER_PORT,
    // Trace lineage rides on the container so a boot-time cleanup after a crash can close the
    // original trace instead of orphaning it as `running` forever.
    "--label", "io.codejam.preview-id=" + options.previewId,
    "--label", "io.codejam.preview-trace=" + options.traceId,
    "--label", "io.codejam.preview-span=" + options.spanId,
    config.containerRuntimeImage,
    ...PREVIEW_COMMANDS[options.command],
  ];
}

interface ActivePreview {
  view: WorkspacePreview;
  traceId: string;
  spanId: string;
  timer: NodeJS.Timeout;
  startedAtMs: number;
}

const PS_FORMAT =
  '{{.Names}}\t{{.Label "io.codejam.agent-id"}}\t{{.Label "io.codejam.preview-id"}}\t{{.Label "io.codejam.preview-trace"}}\t{{.Label "io.codejam.preview-span"}}';

/**
 * #96: one long-lived hardened container per Agent serving its workspace on a published loopback
 * port. Same image and flags as `ContainerCodexRunner` minus credentials/codex-home; lifecycle is
 * host-side (TTL timer, `rm --force`), and both edges are observed as `runtime.preview.*` events on
 * one trace per preview. State is in-process only — a restart removes stale containers via
 * `cleanupStale()` and closes their traces from the labels.
 */
export class PreviewManager {
  private readonly active = new Map<string, ActivePreview>();
  /** Agents whose `start` is between the duplicate check and `active.set` — closes the TOCTOU
   * where two concurrent POSTs both pass `active.has` and the loser 502s on the name conflict. */
  private readonly starting = new Set<string>();
  private readonly engine: PreviewEngine;

  constructor(
    private readonly config: AppConfig,
    private readonly emitter: ObservationEmitter = createDefaultEmitter(),
    engine?: PreviewEngine,
  ) {
    this.engine = engine ?? {
      exec: (args, timeoutMs = 15_000) =>
        execFileAsync(config.containerEngine, args, { timeout: timeoutMs, env: this.childEnvironment() }),
    };
  }

  get(agentId: string): WorkspacePreview | undefined {
    return this.active.get(agentId)?.view;
  }

  /** #335: previews need a reachable engine daemon and the runtime image they run (`preview.ts`
   * containers use `containerRuntimeImage` too) — not `RUNTIME_PROVIDER=container`. Same probe
   * shape as `ContainerCodexRunner.isAvailable()`, routed through the injectable engine. */
  async isAvailable(): Promise<boolean> {
    try {
      await this.engine.exec(["version"], 5_000);
      await this.engine.exec(["image", "inspect", this.config.containerRuntimeImage], 5_000);
      return true;
    } catch {
      return false;
    }
  }

  /** Like `get`, but verified against the engine — a container observed as exited (or already
   * `--rm`-removed) gets a `stopped` event with reason `exited` and is cleared. An engine that
   * cannot answer (daemon down, timeout) is NOT an observation of exit: the last known state is
   * reported unchanged rather than fabricating a close (invariant 3). */
  async status(agentId: string): Promise<WorkspacePreview | undefined> {
    const active = this.active.get(agentId);
    if (!active) return undefined;
    try {
      const { stdout } = await this.engine.exec(["inspect", "--format", "{{.State.Running}}", active.view.containerName]);
      if (stdout.trim() === "true") return active.view;
    } catch (error) {
      if (!CONTAINER_GONE.test(String(error))) return active.view;
    }
    await this.stop(agentId, "exited").catch(() => undefined);
    return this.get(agentId);
  }

  async start(agent: { id: string; workspacePath: string }, command: PreviewCommand): Promise<WorkspacePreview> {
    if (this.active.has(agent.id) || this.starting.has(agent.id)) {
      throw new HttpError(409, "A preview is already running for this Agent — stop it first");
    }
    this.starting.add(agent.id);
    try {
      return await this.startLocked(agent, command);
    } finally {
      this.starting.delete(agent.id);
    }
  }

  private async startLocked(agent: { id: string; workspacePath: string }, command: PreviewCommand): Promise<WorkspacePreview> {
    if (!(command in PREVIEW_COMMANDS)) {
      throw new HttpError(400, "Unknown preview command");
    }
    if (command === "static") {
      const distIsDirectory = await stat(path.join(agent.workspacePath, "dist")).then((s) => s.isDirectory(), () => false);
      if (!distIsDirectory) {
        throw new HttpError(400, "The static preview serves dist/ and this workspace has none — build first or use the vite command");
      }
    }
    const previewId = "prv-" + randomUUID();
    const traceId = newId("trc");
    const spanId = newId("spn");
    const containerName = previewContainerName(agent.id, this.config.runtimeInstanceId);
    const usedPorts = new Set([...this.active.values()].map((preview) => preview.view.port));
    let port: number | undefined;
    for (let candidate = this.config.previewPortStart; candidate <= this.config.previewPortEnd; candidate += 1) {
      if (usedPorts.has(candidate)) continue;
      try {
        await this.engine.exec(
          buildPreviewContainerArgs({ config: this.config, agentId: agent.id, workspacePath: agent.workspacePath, port: candidate, command, previewId, traceId, spanId }),
          30_000,
        );
        port = candidate;
        break;
      } catch (error) {
        // Something outside this process holds the port: try the next one. Anything else is the
        // engine failing for real — retrying other ports would just repeat it.
        if (/port is already allocated|address already in use/i.test(String(error))) continue;
        throw new HttpError(502, "Could not start the preview container: " + redactText(String(error)).text.slice(0, 300));
      }
    }
    if (port === undefined) {
      throw new HttpError(409, "No free preview port in PREVIEW_PORT_RANGE (" + this.config.previewPortStart + "-" + this.config.previewPortEnd + ")");
    }
    const startedAtMs = Date.now();
    const timer = setTimeout(() => void this.stop(agent.id, "ttl_expired").catch(() => undefined), this.config.previewTtlMs);
    timer.unref();
    const view: WorkspacePreview = {
      previewId,
      agentId: agent.id,
      command,
      port,
      url: "http://localhost:" + port,
      containerName,
      startedAt: new Date(startedAtMs).toISOString(),
      expiresAt: new Date(startedAtMs + this.config.previewTtlMs).toISOString(),
    };
    this.active.set(agent.id, { view, traceId, spanId, timer, startedAtMs });
    this.emitter.emit({
      traceId,
      spanId,
      runId: previewId,
      agentId: agent.id,
      actorId: "local-user",
      actorType: "human",
      type: "runtime.preview.started",
      category: "infrastructure",
      phase: "start",
      status: "running",
      name: "workspace preview",
      source: { component: "PreviewManager", observed: true },
      attributes: {
        engine: this.config.containerEngine,
        image: this.config.containerRuntimeImage,
        containerName,
        port,
        command,
        ttlMs: this.config.previewTtlMs,
      },
    });
    return view;
  }

  async stop(agentId: string, reason: PreviewStopReason = "user_request"): Promise<WorkspacePreview | undefined> {
    const active = this.active.get(agentId);
    if (!active) return undefined;
    clearTimeout(active.timer);
    if (!(await this.removeContainer(active.view.containerName))) {
      // The engine did not confirm the removal, so the container may still be serving the port.
      // Emitting `stopped` now would assert an exposure ended that did not (invariant 3): keep the
      // preview tracked, retry, and tell the caller the truth.
      active.timer = setTimeout(() => void this.stop(agentId, reason).catch(() => undefined), REMOVE_RETRY_MS);
      active.timer.unref();
      throw new HttpError(502, "The container engine did not confirm removing the preview container — it may still be serving; removal will be retried");
    }
    this.active.delete(agentId);
    this.emitter.emit({
      traceId: active.traceId,
      spanId: active.spanId,
      runId: active.view.previewId,
      agentId,
      // TTL/exit/stale removals are the server acting, not the operator.
      actorId: reason === "user_request" || reason === "agent_deleted" ? "local-user" : "server",
      actorType: reason === "user_request" || reason === "agent_deleted" ? "human" : "service",
      type: "runtime.preview.stopped",
      category: "infrastructure",
      phase: "end",
      // A container that died on its own is not a clean lifecycle; the index takes this status (#96).
      status: reason === "exited" ? "error" : "ok",
      name: "workspace preview",
      durationMs: Math.max(0, Date.now() - active.startedAtMs),
      source: { component: "PreviewManager", observed: true },
      attributes: { containerName: active.view.containerName, port: active.view.port, reason },
    });
    return active.view;
  }

  /** True only when the engine confirmed the container is gone (removed now, or already absent). */
  private async removeContainer(containerName: string): Promise<boolean> {
    try {
      await this.engine.exec(["rm", "--force", containerName]);
      return true;
    } catch (error) {
      return CONTAINER_GONE.test(String(error));
    }
  }

  /**
   * Boot-time sweep: previews never survive a restart (their TTL timers died with the process), so
   * remove every leftover preview container of this instance and close each one's original trace
   * from the labels it carries. Engine failures are swallowed — a missing engine must not block
   * boot — but a removal the engine did not confirm is never reported (or recorded) as done.
   *
   * `knownTraces` (the trace-store index) lets the sweep also close preview traces whose container
   * is already gone (`--rm` self-removal before a restart): without that, such a trace would stay
   * `running` forever and retention could never evict it. The close is honest about what it knows —
   * an instant marker with status `unset` and reason `not_observed`; the started span stays
   * incomplete because its end was genuinely never seen.
   */
  async cleanupStale(knownTraces: readonly { runId: string; traceId: string; agentId: string; status: string }[] = []): Promise<string[]> {
    const removed: string[] = [];
    /** Preview runIds whose container still exists (removed or not) — excluded from the orphan pass. */
    const seenPreviewIds = new Set<string>();
    try {
      const { stdout } = await this.engine.exec([
        "ps", "--all",
        "--filter", "label=io.codejam.launchpad=agent-preview",
        "--filter", "name=launchpad-preview-" + this.config.runtimeInstanceId + "-",
        "--format", PS_FORMAT,
      ]);
      for (const line of stdout.split("\n")) {
        const [name, agentId, previewId, traceId, spanId] = line.split("\t");
        if (!name) continue;
        if (previewId) seenPreviewIds.add(previewId);
        if (!(await this.removeContainer(name))) continue;
        removed.push(name);
        // Only with full lineage: closing a trace on guessed or fabricated ids is not evidence.
        if (!agentId || !previewId || !traceId || !spanId) continue;
        this.emitter.emit({
          traceId,
          spanId,
          runId: previewId,
          agentId,
          actorId: "server",
          actorType: "service",
          type: "runtime.preview.stopped",
          category: "infrastructure",
          phase: "end",
          status: "ok",
          name: "workspace preview",
          source: { component: "PreviewManager", observed: true },
          attributes: { containerName: name, reason: "stale_cleanup" },
        });
      }
    } catch {
      return removed;
    }
    for (const entry of knownTraces) {
      if (!entry.runId.startsWith("prv-") || entry.status !== "running" || seenPreviewIds.has(entry.runId)) continue;
      this.emitter.emit({
        traceId: entry.traceId,
        spanId: newId("spn"),
        runId: entry.runId,
        agentId: entry.agentId,
        actorId: "server",
        actorType: "service",
        type: "runtime.preview.stopped",
        category: "infrastructure",
        phase: "instant",
        status: "unset",
        name: "workspace preview",
        source: { component: "PreviewManager", observed: true },
        attributes: { reason: "not_observed" },
      });
    }
    return removed;
  }

  /** Same allow-list discipline as the runners: never inherit the full process env (#96). */
  private childEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = { NO_COLOR: "1" };
    for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "XDG_RUNTIME_DIR", "DOCKER_HOST"] as const) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return environment;
  }
}
