import { z } from "zod";
import type { JsonStore } from "../store.js";
import type { EvaluatorDefinition } from "./evaluation.js";
import type { RunEvaluation, RunEvaluator } from "./jobs.js";
import { redactText } from "./redact.js";
import { capturesSummaries, type ObservationEvent } from "./schema.js";
import type { RunSummary } from "./summary.js";
import type { TraceStore } from "./store.js";

const MAX_VIEW_CHARS = 16_384;
/** A hung provider must not stall the single evaluation worker across its retries. */
const JUDGE_TIMEOUT_MS = 60_000;
const MAX_CONVERSATION_CHARS = 2_048;
const MAX_ITEMS_PER_SECTION = 40;
const EVENT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export const taskCompletionOutputSchema = z.object({
  score: z.number().int().min(1).max(5),
  passed: z.boolean(),
  explanation: z.string().trim().min(1).max(4_096),
  citedEventIds: z.array(z.string().regex(EVENT_ID)).max(50),
}).strict();

export type TaskCompletionOutput = z.infer<typeof taskCompletionOutputSchema>;

export interface TaskCompletionSourceRecord {
  userRequest: string;
  finalResponse?: string | undefined;
  events: ObservationEvent[];
}

export interface TaskCompletionSource {
  load(runId: string): Promise<TaskCompletionSourceRecord>;
}

export class JsonTaskCompletionSource implements TaskCompletionSource {
  constructor(private readonly store: JsonStore, private readonly traces: TraceStore) {}

  async load(runId: string): Promise<TaskCompletionSourceRecord> {
    const snapshot = this.store.snapshot();
    const run = snapshot.runs.find((item) => item.id === runId);
    const messages = snapshot.messages.filter((message) => message.runId === runId);
    const userRequest = messages.find((message) => message.role === "user")?.content ?? run?.prompt ?? "";
    // EvalRuns (#105) never create Messages; their reply lives on run.output (#306) — mirror the prompt fallback above.
    const finalResponse = messages.filter((message) => message.role === "assistant").at(-1)?.content ?? run?.output ?? undefined;
    return {
      userRequest,
      ...(finalResponse === undefined ? {} : { finalResponse }),
      events: await this.traces.readRun(runId),
    };
  }
}

export interface BuiltEvaluationView {
  /** Redacted, bounded JSON sent to the judge. */
  text: string;
  /** Complete stored evidence-id allow-list; never supplied by the judge. */
  eventIds: string[];
  truncated: boolean;
}

type TextRedactor = (text: string) => { text: string };

const safeText = (text: string, max: number, redact: TextRedactor): string => {
  try { return redact(text).text.slice(0, max); }
  catch { return "[REDACTED:failed_closed]"; }
};

const stringAttribute = (event: ObservationEvent, key: string, max = 512): string | undefined => {
  const value = event.attributes[key];
  return typeof value === "string" ? value.slice(0, max) : undefined;
};

const numberAttribute = (event: ObservationEvent, key: string): number | undefined => {
  const value = event.attributes[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const eventIds = (events: readonly ObservationEvent[]): string[] => events.map((event) => event.eventId);

const compact = <T>(values: readonly (T | undefined)[]): T[] => values.filter((value): value is T => value !== undefined);

/**
 * Builds the only payload allowed to cross the evaluation/provider boundary. Conversation text is
 * ephemeral, every evidence section carries stored event ids, and the final serialized document is
 * redacted again as one unit before it leaves the process.
 */
export function buildEvaluationView(
  input: { summary: RunSummary; userRequest: string; finalResponse: string; events: ObservationEvent[] },
  redact: TextRedactor = redactText,
): BuiltEvaluationView {
  const events = [...input.events].sort((a, b) => a.sequence - b.sequence);
  const created = events.filter((event) => event.type === "run.created");
  const terminal = events.filter((event) => /^run\.(completed|failed|cancelled|timed_out)$/.test(event.type));
  const tools = events.filter((event) => event.type === "tool.call.completed" || event.type === "tool.call.failed").slice(0, MAX_ITEMS_PER_SECTION);
  const workspace = events.filter((event) => event.type === "workspace.changed").slice(0, MAX_ITEMS_PER_SECTION);
  const postChecks = events.filter((event) => event.type === "runtime.postcheck.completed" || event.type === "runtime.postcheck.failed").slice(0, MAX_ITEMS_PER_SECTION);
  const failures = events.filter((event) => event.status === "error" || event.status === "timeout" || event.status === "cancelled" || event.type === "policy.denied").slice(0, MAX_ITEMS_PER_SECTION);
  const recovery = failures.map((failed) => {
    const recovered = events.find((event) => event.sequence > failed.sequence && event.status === "ok" && (event.spanId === failed.spanId || event.name === failed.name));
    return recovered ? { failedEventId: failed.eventId, recoveredEventId: recovered.eventId, eventIds: [failed.eventId, recovered.eventId] } : undefined;
  }).filter((item): item is NonNullable<typeof item> => item !== undefined).slice(0, MAX_ITEMS_PER_SECTION);
  const metricEvents = events.filter((event) => event.type === "model.completed" || terminal.includes(event));

  const view = {
    schemaVersion: "task_completion_view@1",
    run: {
      runId: input.summary.runId,
      executionStatus: input.summary.executionStatus,
      capturePolicy: input.summary.capturePolicy,
      durationMs: input.summary.durationMs,
      tokens: input.summary.metrics.tokens,
      eventIds: eventIds(metricEvents),
    },
    conversation: {
      request: { text: safeText(input.userRequest, MAX_CONVERSATION_CHARS, redact), eventIds: eventIds(created) },
      finalResponse: { text: safeText(input.finalResponse, MAX_CONVERSATION_CHARS, redact), eventIds: eventIds(terminal) },
    },
    tools: {
      count: input.summary.metrics.toolCalls,
      failures: input.summary.metrics.toolFailures,
      eventIds: eventIds(tools),
      items: tools.map((event) => ({
        eventId: event.eventId,
        status: event.status,
        name: event.name,
        program: stringAttribute(event, "program", 80),
        argument0: stringAttribute(event, "argument0", 80),
        exitCode: numberAttribute(event, "exitCode"),
        error: event.error ? safeText(event.error.message, 512, redact) : undefined,
        ...(capturesSummaries(input.summary.capturePolicy) && event.summary
          ? { commandHead: safeText(event.summary.text, 120, redact) }
          : {}),
      })),
    },
    workspaceChanges: {
      eventIds: eventIds(workspace),
      items: workspace.map((event) => ({
        eventId: event.eventId,
        added: numberAttribute(event, "added"),
        modified: numberAttribute(event, "modified") ?? numberAttribute(event, "updated"),
        removed: numberAttribute(event, "removed") ?? numberAttribute(event, "deleted"),
        bytesDelta: numberAttribute(event, "bytesDelta"),
        paths: stringAttribute(event, "paths"),
      })),
    },
    postChecks: {
      eventIds: eventIds(postChecks),
      items: postChecks.map((event) => ({
        eventId: event.eventId,
        status: event.status,
        exitCode: numberAttribute(event, "exitCode"),
        durationMs: numberAttribute(event, "durationMs") ?? event.durationMs,
        ...(capturesSummaries(input.summary.capturePolicy) && event.summary
          ? { commandHead: safeText(event.summary.text, 120, redact) }
          : {}),
      })),
    },
    failuresAndDenials: {
      eventIds: eventIds(failures),
      items: failures.map((event) => ({
        eventId: event.eventId,
        type: event.type,
        status: event.status,
        name: event.name,
        errorType: event.error?.type,
        error: event.error ? safeText(event.error.message, 512, redact) : undefined,
        program: stringAttribute(event, "program", 80),
        exitCode: numberAttribute(event, "exitCode"),
      })),
    },
    recovery: { eventIds: [...new Set(recovery.flatMap((item) => item.eventIds))], items: recovery },
  };

  let serialized: string;
  try { serialized = redact(JSON.stringify(view)).text; }
  catch {
    serialized = JSON.stringify({ schemaVersion: "task_completion_view@1", run: { runId: input.summary.runId, executionStatus: input.summary.executionStatus }, redactionFailedClosed: true });
  }
  let truncated = false;
  if (serialized.length > MAX_VIEW_CHARS) {
    truncated = true;
    const redacted = serialized;
    let bound = MAX_VIEW_CHARS - 512;
    do {
      serialized = JSON.stringify({ schemaVersion: "task_completion_view@1", runId: input.summary.runId, truncated: true, boundedView: redacted.slice(0, bound) });
      bound = Math.max(0, bound - 512);
    } while (serialized.length > MAX_VIEW_CHARS && bound > 0);
  }
  return { text: serialized, eventIds: eventIds(events), truncated };
}

export interface TaskCompletionJudgeRequest {
  definition: EvaluatorDefinition;
  view: string;
}

export interface TaskCompletionJudge {
  readonly model: string;
  judge(request: TaskCompletionJudgeRequest): Promise<unknown>;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class ArkTaskCompletionJudge implements TaskCompletionJudge {
  readonly model: string;
  private readonly fetcher: Fetch;

  constructor(private readonly options: { apiKey: string; baseUrl: string; model: string; fetch?: Fetch | undefined }) {
    this.model = options.model;
    this.fetcher = options.fetch ?? fetch;
  }

  async judge(request: TaskCompletionJudgeRequest): Promise<unknown> {
    const response = await this.fetcher(this.options.baseUrl.replace(/\/+$/, "") + "/responses", {
      method: "POST",
      signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
      headers: new Headers({ authorization: "Bearer " + this.options.apiKey, "content-type": "application/json" }),
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        input: [
          // #192: user-defined judges share this runtime, so the frame comes from the definition.
          { role: "system", content: [{ type: "input_text", text: `You are ${request.definition.id}@${request.definition.version}. Judge only the supplied redacted evidence. Return exactly one JSON object with score (integer ${request.definition.minScore}-${request.definition.maxScore}), passed (score >= ${request.definition.passThreshold}), explanation, and citedEventIds. Every factual claim must cite supplied event ids. Rubric: ` + request.definition.rubric }] },
          { role: "user", content: [{ type: "input_text", text: request.view }] },
        ],
      }),
    });
    if (!response.ok) {
      const requestId = response.headers.get("x-request-id") ?? response.headers.get("x-tt-logid") ?? response.headers.get("request-id");
      throw new Error(`ModelArk request failed: ${response.status} ${response.statusText}${requestId ? ` (request id: ${requestId})` : ""}`);
    }
    const payload = await response.json() as Record<string, unknown>;
    const text = outputText(payload);
    if (!text) throw new Error("ModelArk response did not contain output text");
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end < start) throw new Error("ModelArk response did not contain a JSON object");
    try { return JSON.parse(text.slice(start, end + 1)); }
    catch { throw new Error("ModelArk response contained invalid JSON"); }
  }
}

function outputText(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.output_text === "string") return payload.output_text;
  if (Array.isArray(payload.output)) {
    const parts: string[] = [];
    for (const item of payload.output) {
      if (!item || typeof item !== "object") continue;
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") parts.push((part as { text: string }).text);
      }
    }
    if (parts.length) return parts.join("\n");
  }
  const choices = payload.choices;
  if (Array.isArray(choices)) {
    const content = (choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content;
    if (typeof content === "string") return content;
  }
  return undefined;
}

/** Deterministic evidence heuristic for tests and the judged E2E lane; never enabled by default. */
export class FakeTaskCompletionJudge implements TaskCompletionJudge {
  readonly model = "fake-task-completion";
  constructor(private readonly implementation?: ((request: TaskCompletionJudgeRequest) => Promise<unknown>) | undefined) {}

  async judge(request: TaskCompletionJudgeRequest): Promise<unknown> {
    if (this.implementation) return this.implementation(request);
    const view = JSON.parse(request.view) as {
      run?: { executionStatus?: string; eventIds?: string[] };
      tools?: { items?: Array<{ eventId: string; exitCode?: number; status?: string }> };
      workspaceChanges?: { items?: Array<{ eventId: string }> };
      postChecks?: { items?: Array<{ eventId: string; status?: string; exitCode?: number }> };
    };
    const exit127 = view.tools?.items?.find((item) => item.exitCode === 127);
    if (exit127) return { score: 2, passed: false, explanation: "The task did not complete: the cited tool failed with exit code 127.", citedEventIds: [exit127.eventId] };
    const workspace = view.workspaceChanges?.items?.[0];
    const check = view.postChecks?.items?.find((item) => item.status === "ok" && item.exitCode === 0);
    if (workspace && check) return { score: 5, passed: true, explanation: "The cited workspace change and passing post-check show the requested work completed.", citedEventIds: [workspace.eventId, check.eventId] };
    const evidence = compact([workspace?.eventId, check?.eventId, view.run?.eventIds?.at(-1)]);
    const passed = view.run?.executionStatus === "completed";
    return { score: passed ? 4 : 2, passed, explanation: passed ? "The terminal evidence indicates completion." : "The terminal evidence does not indicate completion.", citedEventIds: evidence.slice(0, 2) };
  }
}

export interface AcceptedJudgeVerdict {
  score: number;
  passed: boolean;
  /** Redacted and bounded; safe to persist. */
  explanation: string;
  /** Citations that reference stored events, deduplicated in judge order. */
  citedEventIds: string[];
  /** True when the judge cited ids outside the stored allow-list (they were dropped). */
  uncited: boolean;
}

/**
 * The one gate every judge verdict passes before persistence (#177 shares it): the score must sit
 * inside the definition's own range (#192), `passed` must agree with the pass threshold, citations
 * are clamped to the stored evidence allow-list, and the explanation is redacted fail-closed.
 */
export function acceptJudgeVerdict(definition: EvaluatorDefinition, view: BuiltEvaluationView, raw: unknown): AcceptedJudgeVerdict {
  const output = taskCompletionOutputSchema
    .extend({ score: z.number().int().min(definition.minScore).max(definition.maxScore) })
    .parse(raw);
  if (output.passed !== (output.score >= definition.passThreshold)) throw new Error("Judge output is inconsistent with the evaluator pass threshold");
  const allowed = new Set(view.eventIds);
  const missing = output.citedEventIds.filter((id) => !allowed.has(id));
  const cited = [...new Set(output.citedEventIds.filter((id) => allowed.has(id)))];
  let explanation: string;
  try { explanation = redactText(output.explanation).text.slice(0, 4_096); }
  catch { explanation = "[REDACTED:failed_closed]"; }
  return { score: output.score, passed: output.passed, explanation, citedEventIds: cited, uncited: missing.length > 0 };
}

export class TaskCompletionEvaluator implements RunEvaluator {
  constructor(private readonly source: TaskCompletionSource, private readonly judge: TaskCompletionJudge) {}

  async evaluate(summary: RunSummary, definition: EvaluatorDefinition): Promise<RunEvaluation> {
    const source = await this.source.load(summary.runId);
    if (source.finalResponse === undefined) {
      return { passed: false, explanation: "no final response", evidenceEventIds: [], metadata: { noFinalResponse: true } };
    }
    const view = buildEvaluationView({ summary, userRequest: source.userRequest, finalResponse: source.finalResponse, events: source.events });
    const verdict = acceptJudgeVerdict(definition, view, await this.judge.judge({ definition, view: view.text }));
    return {
      score: verdict.score,
      passed: verdict.passed,
      explanation: verdict.explanation,
      evidenceEventIds: verdict.citedEventIds,
      evaluatorModel: this.judge.model,
      metadata: { ...(verdict.uncited ? { uncited: true } : {}), ...(view.truncated ? { viewTruncated: true } : {}) },
    };
  }
}
