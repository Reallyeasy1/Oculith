import { z } from "zod";
import type { AgentRun, RegressionCase } from "../types.js";
import type { TraceView } from "../glassbox/query.js";
import { assertionSchema, type Assertion } from "./evaluators.js";

export const regressionCaseInput = z.object({
  name: z.string().trim().min(1).max(120), prompt: z.string().trim().min(1).max(50_000),
  workspaceTemplate: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/), baselineConfigHash: z.string().min(1).max(128),
  sourceRunId: z.string().uuid().optional(),
  assertions: z.array(assertionSchema).min(1).max(16),
});
export type RegressionCaseInput = z.infer<typeof regressionCaseInput>;

export function prefillAssertions(view: TraceView): Assertion[] {
  const programs = [...new Set(view.events.filter((event) => event.category === "tool" && typeof event.attributes.program === "string").map((event) => String(event.attributes.program)))].slice(0, 3);
  const toolCalls = new Set(view.events.filter((event) => event.category === "tool" && event.type.startsWith("tool.call.")).map((event) => event.spanId)).size;
  const assertions: Assertion[] = [{ type: "terminal_status", expected: "ok" }, ...programs.map((program) => ({ type: "expected_tool" as const, program }))];
  if (toolCalls > 0) assertions.push({ type: "max_tool_calls", max: toolCalls * 2 });
  if (view.summary.durationMs !== undefined) assertions.push({ type: "max_duration_ms", max: Math.ceil(view.summary.durationMs * 1.5) });
  return assertions;
}

export function caseFromRun(run: AgentRun, view: TraceView, workspaceTemplate: string): RegressionCaseInput {
  if (view.summary.status !== "ok") throw new Error("Only successful Runs can become regression cases");
  if (!run.configHash) throw new Error("Run has no baseline configuration hash");
  return {
    name: `Case from Run ${run.id.slice(0, 8)} · ${workspaceTemplate}`,
    prompt: run.prompt,
    workspaceTemplate,
    sourceRunId: run.id,
    baselineConfigHash: run.configHash,
    assertions: prefillAssertions(view),
  };
}
