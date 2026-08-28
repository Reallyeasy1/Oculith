import { appendFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { redactText } from "./glassbox/redact.js";

export interface RunLogLine {
  time: string;
  level: string;
  msg: string;
  runId: string;
  traceId: string;
  agentId: string;
  component?: string | undefined;
  spanId?: string | undefined;
  err?: string | undefined;
}

export type RunLogViewLine = Pick<RunLogLine, "runId" | "time" | "level" | "msg"> &
  Partial<Pick<RunLogLine, "component" | "spanId" | "err">>;

const LOG_SECRET_ASSIGNMENT = /\b(?:token|secret|password|api[_-]?key)\s*=\s*[^\s]+/gi;

export class RunLogStore {
  private readonly file: string;
  private writeQueue: Promise<void> = Promise.resolve();
  constructor(
    private readonly directory: string,
    private readonly maxBytes: number,
    private readonly keep = 3,
    private readonly extraPatterns: RegExp[] = [],
  ) {
    this.file = path.join(directory, "server.ndjson");
  }

  async initialize(): Promise<void> { await mkdir(this.directory, { recursive: true }); }

  async append(line: RunLogLine): Promise<void> {
    const safe = (value: string): string => redactText(value, [LOG_SECRET_ASSIGNMENT, ...this.extraPatterns]).text.slice(0, 2_048);
    const clean: RunLogLine = {
      ...line,
      msg: safe(line.msg),
      ...(line.component ? { component: safe(line.component) } : {}),
      ...(line.err ? { err: safe(line.err) } : {}),
    };
    const write = async () => {
      const encoded = JSON.stringify(clean) + "\n";
      const bytes = Buffer.byteLength(encoded, "utf8");
      let current = 0;
      try { current = (await stat(this.file)).size; } catch { /* first line */ }
      if (current > 0 && current + bytes > this.maxBytes) await this.rotate();
      await appendFile(this.file, encoded, "utf8");
    };
    // Rotation and append must be one serialized operation; concurrent Run loggers otherwise race
    // renames and can silently lose a line. A failed write must not poison subsequent writes.
    this.writeQueue = this.writeQueue.then(write, write);
    return this.writeQueue;
  }

  async flush(): Promise<void> { await this.writeQueue; }

  child(bindings: Pick<RunLogLine, "runId" | "traceId" | "agentId"> & { component?: string | undefined }) {
    return {
      info: (msg: string) => this.append({ ...bindings, time: new Date().toISOString(), level: "info", msg }),
      error: (msg: string, err?: string) => this.append({ ...bindings, time: new Date().toISOString(), level: "error", msg, ...(err ? { err } : {}) }),
    };
  }

  // ponytail: full scan of up to keep × maxBytes per request; add a per-Run offset index if /logs latency matters.
  async readRun(runId: string, options: { level?: string | undefined; limit: number }): Promise<{ lines: RunLogViewLine[]; truncated: boolean }> {
    const lines: RunLogViewLine[] = [];
    const files = [...Array(Math.max(0, this.keep - 1)).keys()].reverse().map((index) => this.file + "." + (index + 1)).concat(this.file);
    for (const file of files) {
      let text: string;
      try { text = await readFile(file, "utf8"); } catch { continue; }
      for (const raw of text.split(/\r?\n/)) {
        if (!raw) continue;
        try {
          const line = JSON.parse(raw) as RunLogLine;
          if (line.runId === runId && (!options.level || line.level === options.level)) {
            lines.push({
              runId: line.runId,
              time: line.time,
              level: line.level,
              msg: line.msg,
              ...(line.component ? { component: line.component } : {}),
              ...(line.spanId ? { spanId: line.spanId } : {}),
              ...(line.err ? { err: line.err } : {}),
            });
          }
        } catch { /* a partial/corrupt line is skipped, never returned as content */ }
      }
    }
    return { lines: lines.slice(-options.limit), truncated: lines.length > options.limit };
  }

  private async rotate(): Promise<void> {
    await rm(this.file + "." + (this.keep - 1), { force: true });
    for (let index = this.keep - 2; index >= 1; index--) {
      try { await rename(this.file + "." + index, this.file + "." + (index + 1)); } catch { /* absent */ }
    }
    try { await rename(this.file, this.file + ".1"); } catch { /* absent */ }
  }
}
