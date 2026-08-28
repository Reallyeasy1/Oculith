import { HttpError } from "../errors.js";
import type { JsonStore } from "../store.js";
import { redactText } from "./redact.js";
import type { RunSummaryStore } from "./summary.js";

export type EvaluatorType = "deterministic" | "llm_judge";
export type EvaluationFields = Record<string, string | number | boolean | null>;

export interface EvaluatorDefinition {
  id: string;
  name: string;
  version: number;
  type: EvaluatorType;
  rubric: string;
  model?: string | undefined;
  minScore: number;
  maxScore: number;
  passThreshold: number;
  config: EvaluationFields;
  setsTaskOutcome: boolean;
  createdAt: string;
}

export type EvaluatorDefinitionInput = Omit<EvaluatorDefinition, "version" | "createdAt">;

export interface EvaluationResult {
  runId: string;
  evaluatorId: string;
  evaluatorVersion: number;
  score?: number | undefined;
  passed: boolean;
  explanation: string;
  evidenceEventIds: string[];
  evaluatorModel?: string | undefined;
  metadata: EvaluationFields;
  evaluatedAt: string;
  jobId?: string | undefined;
}

export interface EvaluationQuery {
  agentId?: string | undefined;
  evaluatorId?: string | undefined;
  version?: number | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

export interface EvaluationStore {
  initialize(): Promise<void>;
  listDefinitions(): Promise<EvaluatorDefinition[]>;
  getDefinition(id: string, version?: number | undefined): Promise<EvaluatorDefinition | undefined>;
  createDefinition(input: EvaluatorDefinitionInput): Promise<EvaluatorDefinition>;
  putResult(result: EvaluationResult): Promise<EvaluationResult>;
  resultsForRun(runId: string): Promise<EvaluationResult[]>;
  query(query?: EvaluationQuery): Promise<EvaluationResult[]>;
}

const deterministic = (id: string, rubric: string): EvaluatorDefinitionInput => ({
  id, name: id, type: "deterministic", rubric, minScore: 0, maxScore: 1, passThreshold: 1,
  config: { assertionType: id }, setsTaskOutcome: false,
});

export const SEEDED_EVALUATORS: readonly EvaluatorDefinitionInput[] = [
  {
    id: "task_completion", name: "Task Completion", type: "llm_judge",
    rubric: "Score whether the Run completed the requested task using only the redacted evaluation view and cited trace evidence.",
    minScore: 1, maxScore: 5, passThreshold: 4, config: {}, setsTaskOutcome: true,
  },
  deterministic("terminal_status", "Compare the observed terminal status with the expected status."),
  deterministic("expected_tool", "Pass when the expected tool is present in trace evidence."),
  deterministic("max_tool_calls", "Pass when observed tool calls do not exceed the configured maximum."),
  deterministic("max_duration_ms", "Pass when observed Run duration does not exceed the configured maximum."),
  deterministic("post_check", "Pass when the allow-listed post-check exits successfully."),
];

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => JSON.stringify(key) + ":" + canonical(entry)).join(",") + "}";
  return JSON.stringify(value);
};

const comparable = (definition: EvaluatorDefinition | EvaluatorDefinitionInput) => ({
  id: definition.id, name: definition.name, type: definition.type, rubric: definition.rubric,
  model: definition.model, minScore: definition.minScore, maxScore: definition.maxScore,
  passThreshold: definition.passThreshold, config: definition.config, setsTaskOutcome: definition.setsTaskOutcome,
});

function current(results: readonly EvaluationResult[]): EvaluationResult[] {
  const latest = new Map<string, EvaluationResult>();
  for (const result of results) {
    const key = `${result.runId}\0${result.evaluatorId}\0${result.evaluatorVersion}`;
    const prior = latest.get(key);
    if (!prior || result.evaluatedAt >= prior.evaluatedAt) latest.set(key, result);
  }
  return [...latest.values()].sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt));
}

export class JsonEvaluationStore implements EvaluationStore {
  constructor(
    private readonly store: JsonStore,
    private readonly summaries: RunSummaryStore,
    private readonly redact: (text: string) => string = (text) => redactText(text).text.slice(0, 4_096),
  ) {}

  private safeText(text: string): string {
    try { return this.redact(text); }
    catch { return "[REDACTED:failed_closed]"; }
  }

  private safeFields(fields: EvaluationFields): EvaluationFields {
    const out: EvaluationFields = {};
    for (const [key, value] of Object.entries(fields)) {
      const snake = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
      if (/(^|[_.-])(authorization|api[_-]?key|token|secret|password|cookie|private[_-]?key)($|[_.-])/i.test(snake)) continue;
      out[key] = typeof value === "string" ? this.safeText(value) : value;
    }
    return out;
  }

  async initialize(): Promise<void> {
    await this.store.mutate((database) => {
      const timestamp = new Date().toISOString();
      for (const seed of SEEDED_EVALUATORS) {
        if (database.evaluatorDefinitions.some((item) => item.id === seed.id && item.version === 1)) continue;
        database.evaluatorDefinitions.push({ ...seed, version: 1, createdAt: timestamp });
      }
    });
  }

  async listDefinitions(): Promise<EvaluatorDefinition[]> {
    return this.store.snapshot().evaluatorDefinitions.sort((a, b) => a.name.localeCompare(b.name) || b.version - a.version);
  }

  async getDefinition(id: string, version?: number): Promise<EvaluatorDefinition | undefined> {
    return this.store.snapshot().evaluatorDefinitions
      .filter((item) => item.id === id && (version === undefined || item.version === version))
      .sort((a, b) => b.version - a.version)[0];
  }

  async createDefinition(input: EvaluatorDefinitionInput): Promise<EvaluatorDefinition> {
    if (input.minScore > input.maxScore || input.passThreshold < input.minScore || input.passThreshold > input.maxScore) {
      throw new Error("Invalid evaluator score range");
    }
    const safe: EvaluatorDefinitionInput = {
      ...input, name: this.safeText(input.name), rubric: this.safeText(input.rubric),
      ...(input.model === undefined ? {} : { model: this.safeText(input.model) }), config: this.safeFields(input.config),
    };
    const definition = await this.store.mutate((database) => {
      const versions = database.evaluatorDefinitions.filter((item) => item.id === input.id).sort((a, b) => b.version - a.version);
      const latest = versions[0];
      if (latest && canonical(comparable(latest)) === canonical(comparable(safe))) return latest;
      const created: EvaluatorDefinition = { ...safe, version: (latest?.version ?? 0) + 1, createdAt: new Date().toISOString() };
      database.evaluatorDefinitions.push(created);
      return created;
    });
    return structuredClone(definition);
  }

  async putResult(input: EvaluationResult): Promise<EvaluationResult> {
    const definition = await this.getDefinition(input.evaluatorId, input.evaluatorVersion);
    if (!definition) throw new HttpError(404, "Evaluator definition not found");
    if (input.score !== undefined && (input.score < definition.minScore || input.score > definition.maxScore)) throw new HttpError(400, "Evaluation score is outside the evaluator range");
    const summary = await this.summaries.get(input.runId);
    if (!summary) throw new HttpError(404, "Run summary not found");
    const result: EvaluationResult = {
      ...input, explanation: this.safeText(input.explanation), metadata: this.safeFields(input.metadata),
      // FR-21: `evaluatorModel` is provenance of a judge only; a deterministic result never carries one.
      ...(definition.type === "llm_judge" && input.evaluatorModel !== undefined ? { evaluatorModel: this.safeText(input.evaluatorModel) } : { evaluatorModel: undefined }),
    };
    await this.store.mutate((database) => { database.evaluationResults.push(structuredClone(result)); });
    // The summary store owns taskOutcome for every backend (JSON or Postgres); FR-22 source vocabulary.
    if (definition.setsTaskOutcome) await this.summaries.setTaskOutcome(input.runId, input.passed ? "passed" : "failed", `evaluator:${input.evaluatorId}@${input.evaluatorVersion}`);
    return structuredClone(result);
  }

  async resultsForRun(runId: string): Promise<EvaluationResult[]> {
    return current(this.store.snapshot().evaluationResults.filter((result) => result.runId === runId));
  }

  async query(query: EvaluationQuery = {}): Promise<EvaluationResult[]> {
    const allowedRuns = query.agentId ? new Set((await this.summaries.query({ agentId: query.agentId })).map((summary) => summary.runId)) : undefined;
    return current(this.store.snapshot().evaluationResults).filter((result) =>
      (!allowedRuns || allowedRuns.has(result.runId)) &&
      (!query.evaluatorId || result.evaluatorId === query.evaluatorId) &&
      (!query.version || result.evaluatorVersion === query.version) &&
      (!query.from || result.evaluatedAt >= query.from) &&
      (!query.to || result.evaluatedAt <= query.to));
  }
}
