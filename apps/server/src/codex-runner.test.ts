import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildCodexArgs, parseCodexEventLine } from "./codex-runner.js";

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
    // Known gap (docs/CODEX_EVENTS.md trap 1): turn.failed nests its message under
    // error.message and is not parsed yet — the top-level error events cover it for now.
  });
});
