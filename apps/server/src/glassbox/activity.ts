import type { RunActivity } from "../types.js";
import { commandIdentity, type CodexStreamSink } from "./codex-observer.js";
import { redactText } from "./redact.js";

const THINKING: RunActivity = { kind: "thinking", label: "Thinking…" };
/** Fail-closed label when a command's identity cannot be derived or redacted safely (invariant 2). */
const GENERIC_COMMAND: RunActivity = { kind: "command", label: "Running a command…" };

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Shell wrappers Codex uses around every command (docs/CODEX_EVENTS.md E3–E5); the script's own
 * first token is the activity, not the wrapper. */
const SHELL_WRAPPERS = new Set(["bash", "sh", "zsh", "dash", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "cmd.exe"]);

/** Tokens shown verbatim must look like a plain shell word: no leading dash (flag-embedded values
 * like `-pPassword`), no `=` (env assignments), shell-word charset only. The pattern scanner only
 * knows known credential shapes, so anything else is dropped from the label rather than trusted. */
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._@/:-]{0,63}$/;

/** Bounded, content-safe label for a command_execution item: only the command's identity tokens
 * (program + first argument, the same #130 metadata the trace stores) survive, filtered to safe
 * word shapes and re-scanned by the redactor. Anything that goes wrong falls back to the generic
 * copy — never the raw command. */
function commandActivity(item: Record<string, unknown>): RunActivity {
  try {
    const identity = commandIdentity(str(item.command) ?? "");
    if (!SAFE_TOKEN.test(identity.program)) return GENERIC_COMMAND;
    const raw = "argument0" in identity ? identity.argument0 : undefined;
    const argument0 = raw !== undefined && SAFE_TOKEN.test(raw) ? raw : undefined;
    const tokens = SHELL_WRAPPERS.has(identity.program.toLowerCase())
      ? [argument0 ?? identity.program]
      : [identity.program, ...(argument0 ? [argument0] : [])];
    const text = redactText(tokens.join(" ")).text.trim();
    if (!text) return GENERIC_COMMAND;
    return { kind: "command", label: ("Running " + text).slice(0, 96) + "…" };
  } catch {
    return GENERIC_COMMAND;
  }
}

/**
 * A `CodexStreamSink` that derives a live activity summary from the same observed events that feed
 * the trace, delegating every hook to an optional inner sink (the trace observer) first.
 *
 * Invariants honoured here:
 *  - 3 (never fabricate): activity only changes on events the stream actually emitted; a stream
 *    with no items reports nothing and the caller keeps its generic copy.
 *  - 4 (telemetry never breaks the Run): the change callback is wrapped; its errors are swallowed.
 *  - 5 (no chain-of-thought): `reasoning` maps to the fixed "Thinking…" label — item text is never read.
 */
export class CodexActivityTracker implements CodexStreamSink {
  private current: RunActivity | null = null;
  private currentItemId: string | undefined;
  private turnActive = false;

  constructor(
    private readonly onChange: (activity: RunActivity | null) => void,
    private readonly inner?: CodexStreamSink | undefined,
  ) {}

  private update(activity: RunActivity | null, itemId?: string): void {
    this.currentItemId = itemId;
    if (activity?.kind === this.current?.kind && activity?.label === this.current?.label) return;
    this.current = activity;
    try {
      this.onChange(activity);
    } catch {
      // Best-effort status: a failed activity write must never reach the runner (invariant 4).
    }
  }

  onThreadStarted(threadId: string): void {
    this.inner?.onThreadStarted(threadId);
  }

  onTurnStarted(): void {
    this.inner?.onTurnStarted();
    this.turnActive = true;
    this.update(THINKING);
  }

  onItemStarted(item: Record<string, unknown>): void {
    this.inner?.onItemStarted(item);
    const kind = str(item.type);
    const itemId = str(item.id);
    if (kind === "command_execution") this.update(commandActivity(item), itemId);
    else if (kind === "file_change") this.update({ kind: "file_change", label: "Editing files…" }, itemId);
    else if (kind === "web_search") this.update({ kind: "web_search", label: "Searching the web…" }, itemId);
    else if (kind === "mcp_tool_call") this.update({ kind: "mcp_tool_call", label: "Calling a tool…" }, itemId);
    else if (kind === "reasoning") this.update(THINKING, itemId);
    // agent_message / unknown kinds are not live-activity signals; the last observed state stands.
  }

  onItemCompleted(item: Record<string, unknown>): void {
    this.inner?.onItemCompleted(item);
    const id = str(item.id);
    // The item on display just ended; inside a still-open turn the model is generating again.
    if (id !== undefined && id === this.currentItemId) {
      this.update(this.turnActive ? THINKING : null);
    }
  }

  onTurnCompleted(usage: Record<string, unknown>): void {
    this.inner?.onTurnCompleted(usage);
    this.turnActive = false;
    this.update(null);
  }

  onError(message: string): void {
    this.inner?.onError(message);
  }
}
