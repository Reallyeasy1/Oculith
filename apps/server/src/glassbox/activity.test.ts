import { describe, expect, it } from "vitest";
import type { RunActivity } from "../types.js";
import { CodexActivityTracker } from "./activity.js";
import type { CodexStreamSink } from "./codex-observer.js";

const collect = () => {
  const seen: Array<RunActivity | null> = [];
  const tracker = new CodexActivityTracker((activity) => seen.push(activity));
  return { seen, tracker };
};

describe("CodexActivityTracker labels (metadata-only, redacted)", () => {
  it("reports Thinking… when a model turn starts", () => {
    const { seen, tracker } = collect();
    tracker.onTurnStarted();
    expect(seen).toEqual([{ kind: "thinking", label: "Thinking…" }]);
  });

  it.each([
    ["/bin/bash -lc 'npm test --silent'", "Running npm…"],
    ["git status --short", "Running git status…"],
    ['"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command "Get-ChildItem"', "Running Get-ChildItem…"],
  ])("labels a command by its bounded identity: %s", (command, label) => {
    const { seen, tracker } = collect();
    tracker.onItemStarted({ id: "item_1", type: "command_execution", command, status: "in_progress" });
    expect(seen).toEqual([{ kind: "command", label }]);
  });

  it.each([
    // Seeded secrets in the identity tokens themselves — the label must never carry them (AC-03).
    ["/bin/bash -lc 'API_KEY=sk-proj-aaaabbbbccccddddeeeeffff npm run deploy'", "sk-proj-"],
    ["deploy-tool sk-proj-aaaabbbbccccddddeeeeffff", "sk-proj-"],
    // A patternless credential the redactor cannot recognize: dropped by token shape, not by scan.
    ["mysql -pHunter2Secret", "Hunter2Secret"],
    ["/bin/bash -lc 'DB_PASSWORD=hunter2secret ./migrate.sh'", "hunter2secret"],
  ])("never surfaces a seeded secret from %s", (command, secretMarker) => {
    const { seen, tracker } = collect();
    tracker.onItemStarted({ id: "item_1", type: "command_execution", command, status: "in_progress" });
    expect(seen).toHaveLength(1);
    const label = (seen[0] as RunActivity).label;
    expect(label).not.toContain(secretMarker);
    expect(label).toContain("Running");
  });

  it("fails closed to the generic label when a wrapped script's first token is unsafe — never the wrapper", () => {
    const { seen, tracker } = collect();
    tracker.onItemStarted({
      id: "item_1",
      type: "command_execution",
      command: "/bin/bash -lc 'DB_PASSWORD=hunter2secret ./migrate.sh'",
    });
    expect(seen).toEqual([{ kind: "command", label: "Running a command…" }]);
  });

  it("falls back to generic copy when the command has no identity", () => {
    const { seen, tracker } = collect();
    tracker.onItemStarted({ id: "item_1", type: "command_execution", command: "", status: "in_progress" });
    expect(seen).toEqual([{ kind: "command", label: "Running a command…" }]);
  });

  it("shows only the fixed Thinking… label for reasoning items — never their text", () => {
    const { seen, tracker } = collect();
    tracker.onItemStarted({ id: "item_1", type: "reasoning", text: "secret plan: read .env first" });
    expect(seen).toEqual([{ kind: "thinking", label: "Thinking…" }]);
  });

  it("labels file changes generically without any file paths", () => {
    const { seen, tracker } = collect();
    tracker.onItemStarted({
      id: "item_1",
      type: "file_change",
      changes: [{ kind: "update", path: "/workspace/secrets/id_rsa" }],
    });
    expect(seen).toEqual([{ kind: "file_change", label: "Editing files…" }]);
  });

  it("ignores agent_message and unknown item kinds (no synthetic activity — invariant 3)", () => {
    const { seen, tracker } = collect();
    tracker.onItemStarted({ id: "item_1", type: "agent_message", text: "hi" });
    tracker.onItemStarted({ id: "item_2", type: "mystery_item" });
    expect(seen).toEqual([]);
  });
});

describe("CodexActivityTracker state transitions", () => {
  it("walks a whole turn: thinking → command → thinking → cleared", () => {
    const { seen, tracker } = collect();
    tracker.onTurnStarted();
    tracker.onItemStarted({ id: "item_1", type: "command_execution", command: "/bin/bash -lc 'npm test'" });
    tracker.onItemCompleted({ id: "item_1", type: "command_execution", command: "/bin/bash -lc 'npm test'", exit_code: 0 });
    tracker.onTurnCompleted({ input_tokens: 1 });
    expect(seen).toEqual([
      { kind: "thinking", label: "Thinking…" },
      { kind: "command", label: "Running npm…" },
      { kind: "thinking", label: "Thinking…" },
      null,
    ]);
  });

  it("keeps the current activity when an unrelated item completes", () => {
    const { seen, tracker } = collect();
    tracker.onTurnStarted();
    tracker.onItemStarted({ id: "item_2", type: "command_execution", command: "git diff" });
    tracker.onItemCompleted({ id: "item_1", type: "reasoning", text: "..." });
    expect(seen.at(-1)).toMatchObject({ kind: "command" });
  });

  it("does not repeat identical activities", () => {
    const { seen, tracker } = collect();
    tracker.onTurnStarted();
    tracker.onTurnStarted();
    expect(seen).toHaveLength(1);
  });

  it("swallows callback errors and keeps delegating (telemetry never breaks the Run — invariant 4)", () => {
    const calls: string[] = [];
    const inner: CodexStreamSink = {
      onThreadStarted: (id) => calls.push("thread:" + id),
      onTurnStarted: () => calls.push("turn"),
      onItemStarted: () => calls.push("item.started"),
      onItemCompleted: () => calls.push("item.completed"),
      onTurnCompleted: () => calls.push("turn.completed"),
      onError: (message) => calls.push("error:" + message),
    };
    const tracker = new CodexActivityTracker(() => {
      throw new Error("store is down");
    }, inner);
    expect(() => {
      tracker.onThreadStarted("thr_1");
      tracker.onTurnStarted();
      tracker.onItemStarted({ id: "item_1", type: "command_execution", command: "ls" });
      tracker.onItemCompleted({ id: "item_1", type: "command_execution", command: "ls", exit_code: 0 });
      tracker.onTurnCompleted({});
      tracker.onError("retrying");
    }).not.toThrow();
    expect(calls).toEqual(["thread:thr_1", "turn", "item.started", "item.completed", "turn.completed", "error:retrying"]);
  });
});
