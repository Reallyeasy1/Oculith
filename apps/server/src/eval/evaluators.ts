import { z } from "zod";
import { type TraceView } from "../glassbox/query.js";
import { type TraceStatus } from "../glassbox/schema.js";

const terminalStatusSchema = z.object({ type: z.literal("terminal_status"), expected: z.enum(["ok", "error", "timeout", "cancelled"]) });
const expectedToolSchema = z.object({ type: z.literal("expected_tool"), program: z.string().trim().min(1).max(120) });
const maxToolCallsSchema = z.object({ type: z.literal("max_tool_calls"), max: z.number().int().nonnegative() });
const maxDurationSchema = z.object({ type: z.literal("max_duration_ms"), max: z.number().int().nonnegative() });
const postCheckSchema = z.object({ type: z.literal("post_check"), command: z.string().trim().min(1).max(1_024), timeoutMs: z.number().int().positive().max(300_000).default(30_000) });

/** The stable assertion contract persisted by regression cases (#84). */
export const assertionSchema = z.discriminatedUnion("type", [terminalStatusSchema, expectedToolSchema, maxToolCallsSchema, maxDurationSchema, postCheckSchema]);
export type Assertion = z.infer<typeof assertionSchema>;

export interface EvalResult {
  type: Assertion["type"];
  pass: boolean;
  expected: string | number;
  observed: string | number | null;
  evidenceEventIds: string[];
  message: string;
}

export interface PostCheckObservation {
  exitCode: number;
  timedOut?: boolean | undefined;
  evidenceEventIds: string[];
}
export interface EvalContext {
  workspacePath?: string | undefined;
  allowedPostCheckCommands?: readonly string[] | undefined;
  runPostCheck?: ((request: { workspacePath: string; command: string; timeoutMs: number }) => Promise<PostCheckObservation>) | undefined;
}

const terminalTypes = new Set(["run.completed", "run.failed", "run.timed_out", "run.cancelled"]);
const terminalEvent = (view: TraceView) => [...view.events].reverse().find((event) => terminalTypes.has(event.type));
const terminalEvidence = (view: TraceView) => {
  const event = terminalEvent(view);
  return event ? [event.eventId] : [];
};

function toolEvents(view: TraceView) {
  return view.events.filter((event) => event.category === "tool" && event.type.startsWith("tool.call."));
}

function toolMatches(event: TraceView["events"][number], program: string): boolean {
  const expected = program.toLowerCase();
  const observedProgram = typeof event.attributes.program === "string" ? event.attributes.program.toLowerCase() : "";
  // The wrapper shell (powershell.exe / bash) is the program on both runtimes; argument0 is the
  // script's own first token ("npm", "node") — the only field that can discriminate commands (#283).
  const observedArgument0 = typeof event.attributes.argument0 === "string" ? event.attributes.argument0.toLowerCase() : "";
  const name = event.name.toLowerCase();
  return observedProgram === expected || observedArgument0 === expected || name === expected || name.endsWith(":" + expected);
}

const result = (type: Assertion["type"], pass: boolean, expected: string | number, observed: string | number | null, evidenceEventIds: string[], message: string): EvalResult => ({ type, pass, expected, observed, evidenceEventIds, message });

async function evaluatePostCheck(assertion: z.infer<typeof postCheckSchema>, context: EvalContext): Promise<EvalResult> {
  if (!context.workspacePath || !context.runPostCheck) {
    return result(assertion.type, false, 0, null, [], "Post-check is unavailable: this evaluation has no workspace runner.");
  }
  if (!context.allowedPostCheckCommands?.includes(assertion.command)) {
    return result(assertion.type, false, 0, null, [], "Post-check command is not allow-listed for this workspace template.");
  }
  try {
    const observed = await context.runPostCheck({ workspacePath: context.workspacePath, command: assertion.command, timeoutMs: assertion.timeoutMs });
    const pass = observed.exitCode === 0 && observed.timedOut !== true;
    const message = observed.timedOut
      ? `Post-check timed out after ${assertion.timeoutMs} ms.`
      : pass ? "Post-check exited 0." : `Post-check exited ${observed.exitCode}.`;
    return result(assertion.type, pass, 0, observed.exitCode, observed.evidenceEventIds, message);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return result(assertion.type, false, 0, null, [], `Post-check failed to start: ${message}`);
  }
}

/** Evaluates only observable trace facts. The injected, allow-listed post-check is the sole side effect. */
export async function evaluate(assertion: Assertion, view: TraceView, context: EvalContext = {}): Promise<EvalResult> {
  switch (assertion.type) {
    case "terminal_status": {
      const observed = view.summary.status as TraceStatus;
      return result(assertion.type, observed === assertion.expected, assertion.expected, observed, terminalEvidence(view), `Expected terminal status ${assertion.expected}; observed ${observed}.`);
    }
    case "expected_tool": {
      const events = toolEvents(view).filter((event) => toolMatches(event, assertion.program));
      const first = events[0];
      // #346: the event name alone is the wrapper shell ("shell:powershell.exe") on wrapped runtimes,
      // which contradicts the "Observed tool npm." message. Append the matched command (argument0,
      // #283) so `observed` names what actually satisfied the assertion; the wrapper identity stays.
      const argument0 = typeof first?.attributes.argument0 === "string" ? first.attributes.argument0 : "";
      const observed = first
        ? (argument0 && !first.name.toLowerCase().includes(argument0.toLowerCase()) ? `${first.name} ${argument0}` : first.name)
        : null;
      return result(assertion.type, events.length > 0, assertion.program, observed, events.map((event) => event.eventId), events.length > 0 ? `Observed tool ${assertion.program}.` : `Expected tool ${assertion.program} was not observed.`);
    }
    case "max_tool_calls": {
      const events = toolEvents(view);
      const bySpan = new Map<string, string>();
      for (const event of events) if (!bySpan.has(event.spanId)) bySpan.set(event.spanId, event.eventId);
      const observed = bySpan.size;
      return result(assertion.type, observed <= assertion.max, assertion.max, observed, [...bySpan.values()], `Expected at most ${assertion.max} tool calls; observed ${observed}.`);
    }
    case "max_duration_ms": {
      const observed = view.summary.durationMs ?? null;
      return result(assertion.type, observed !== null && observed <= assertion.max, assertion.max, observed, terminalEvidence(view), observed === null ? "Run duration was not observed." : `Expected duration at most ${assertion.max} ms; observed ${observed} ms.`);
    }
    case "post_check":
      return evaluatePostCheck(assertion, context);
  }
}

export async function evaluateAll(view: TraceView, assertions: readonly Assertion[], context: EvalContext = {}): Promise<EvalResult[]> {
  return Promise.all(assertions.map((assertion) => evaluate(assertion, view, context)));
}
