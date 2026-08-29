import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { RunLogStore } from "./run-log-store.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("RunLogStore", () => {
  it("redacts, rotates, filters, and reports truncation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "run-logs-")); dirs.push(directory);
    const store = new RunLogStore(directory, 420, 3);
    await store.initialize();
    for (let index = 0; index < 8; index++) {
      await store.append({
        time: new Date(index).toISOString(), level: index % 2 ? "error" : "info", msg: "token=secret-value line " + index,
        runId: "run-1", traceId: "trace-1", agentId: "agent-1",
      });
    }
    const files = await readdir(directory);
    expect(files.length).toBeLessThanOrEqual(3);
    const disk = (await Promise.all(files.map((file) => readFile(path.join(directory, file), "utf8")))).join("");
    expect(disk).not.toContain("secret-value");
    expect(disk).toContain("[REDACTED:");
    const result = await store.readRun("run-1", { level: "error", limit: 2 });
    expect(result.lines).toHaveLength(2);
    expect(result.lines.every((line) => line.level === "error")).toBe(true);
    // the view line carries no identifiers; the request already named the Run (#75)
    expect(result.lines.every((line) => !("runId" in line) && !("traceId" in line))).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it("writes warn lines through child() and serves them to the level filter (#232)", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "run-logs-")); dirs.push(directory);
    const store = new RunLogStore(directory, 1_000_000, 3);
    await store.initialize();
    const child = store.child({ runId: "run-1", traceId: "trace-1", agentId: "agent-1", component: "AgentRunner" });
    await child.info("Run started");
    await child.warn("Sandbox declined shell:pwsh Get-ChildItem");
    await store.flush();
    const result = await store.readRun("run-1", { level: "warn", limit: 10 });
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({ level: "warn", msg: "Sandbox declined shell:pwsh Get-ChildItem" });
  });
});
