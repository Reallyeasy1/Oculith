import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexRunner, buildCodexArgs, parseCodexEventLine } from "./codex-runner.js";
import { loadConfig } from "./config.js";
import { ObservationEmitter } from "./glassbox/emitter.js";
import { MemoryTraceStore } from "./glassbox/store.js";

describe("Codex runner protocol", () => {
  it("builds a new-session invocation", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "build a calculator",
        threadId: null,
      },
      "workspace-write",
    );
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-C",
      "/tmp/workspace",
      "--",
      "build a calculator",
    ]);
  });

  it("resumes a stored Codex thread", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "add tests",
        threadId: "thread-123",
      },
      "workspace-write",
    );
    expect(args.slice(-4)).toEqual(["resume", "thread-123", "--", "add tests"]);
  });

  it("keeps flag-looking prompts positional and rejects flag-looking thread ids", () => {
    const request = {
      agentId: "agent",
      workspacePath: "/tmp/workspace",
      prompt: "--help",
      threadId: null,
    };
    expect(buildCodexArgs(request, "workspace-write").slice(-2)).toEqual(["--", "--help"]);
    expect(() =>
      buildCodexArgs({ ...request, threadId: "--dangerous" }, "workspace-write"),
    ).toThrow("Invalid Codex thread id");
  });

  it("extracts the session, final message and usage", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null as {
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
      } | null,
      errors: [] as string[],
    };
    parseCodexEventLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
      parsed,
    );
    expect(parsed.threadId).toBe("thread-123");
    expect(parsed.messages).toEqual(["Done."]);
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });
});

describe("CodexRunner against a real child process", () => {
  // No module mocks: CODEX_BIN is node itself, so the `exec` subcommand resolves to a script named
  // `exec` in the workspace cwd (node stops parsing its own flags at the script name).
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  const workspace = async (script: string) => {
    const dir = await mkdtemp(path.join(tmpdir(), "codex-runner-"));
    dirs.push(dir);
    await writeFile(path.join(dir, "exec"), script);
    return dir;
  };
  const trace = { traceId: "trc_1", runId: "run-1", agentId: "agt-1", parentSpanId: "spn_svc" };
  const setup = (home: string) => {
    const store = new MemoryTraceStore();
    const emitter = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_BIN: process.execPath,
      CODEX_HOME: home,
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    return { store, emitter, runner: new CodexRunner(config, emitter) };
  };

  it("bounds a 5000-char stderr so the failed span end is still accepted with terminal evidence", async () => {
    const ws = await workspace('process.stdout.write("x"); process.stderr.write("x".repeat(5000)); process.exitCode = 2;');
    const { store, emitter, runner } = setup(ws);
    await expect(
      runner.run({ agentId: "agt-1", workspacePath: ws, prompt: "p", threadId: null, trace }),
    ).rejects.toThrow(/exited with code 2/);
    await emitter.flush();
    const events = await store.readRun("run-1");
    const end = events.find((e) => e.type === "runtime.codex.failed");
    expect(end).toMatchObject({ status: "error", phase: "end", error: { type: "exit_code" } });
    expect(end!.error!.message.length).toBeLessThanOrEqual("Codex exited with code 2: ".length + 1024);
    expect(events.some((e) => e.type === "error.recorded")).toBe(false);
    const firstOutput = events.filter((e) => e.type === "runtime.codex.first_output");
    expect(firstOutput).toHaveLength(1);
    expect(firstOutput[0]).toMatchObject({ phase: "instant", parentSpanId: expect.any(String), attributes: { latencyMs: expect.any(Number) } });
  }, 30_000);
});

describe("Codex stream fixtures", () => {
  // Real captures, see fixtures/codex-stream/README.md + docs/CODEX_EVENTS.md.
  // vitest runs with cwd apps/server, hence the ../..
  const dir = path.join(process.cwd(), "..", "..", "fixtures", "codex-stream");
  const parseFixture = (name: string) => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null as null | Record<string, number>,
      errors: [] as string[],
    };
    for (const line of readFileSync(path.join(dir, name), "utf8").split(/\r?\n/)) {
      if (line.trim()) parseCodexEventLine(line, parsed);
    }
    return parsed;
  };

  it.each(["codex-0.111.jsonl", "codex-0.142.jsonl", "codex-0.142-sandbox-denied.jsonl"])(
    "parses %s to a thread id, a final message and usage",
    (name) => {
      const parsed = parseFixture(name);
      expect(parsed.threadId).toBeTruthy();
      expect(parsed.messages.length).toBeGreaterThan(0);
      expect(parsed.usage).not.toBeNull();
      expect(parsed.usage?.inputTokens).toBeGreaterThan(0);
    },
  );

  it("collects provider errors from a failed turn but gets no usage", () => {
    const parsed = parseFixture("codex-0.111-turn-failed.jsonl");
    expect(parsed.threadId).toBeTruthy();
    expect(parsed.messages).toEqual([]);
    expect(parsed.usage).toBeNull();
    expect(parsed.errors.at(-1)).toContain("401 Unauthorized");
    // docs/CODEX_EVENTS.md trap 1: turn.failed nests its message under error.message. The last
    // recorded error is that verdict, not one of the five preceding "Reconnecting..." notices.
    expect(parsed.errors.at(-1)).not.toContain("Reconnecting");
    expect(parsed.errors).toHaveLength(7);
  });
});
