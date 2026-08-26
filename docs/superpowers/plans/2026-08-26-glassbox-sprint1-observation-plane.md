# GlassBox Sprint 1 — Backend Observation Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Agent Run produces one correlated, redacted, locally persisted trace (schema → emitter → NDJSON store → query API) with a gated deterministic failure fixture, without changing baseline behaviour.

**Architecture:** A new `apps/server/src/glassbox/` module owns the contract (`schema.ts`), redaction (`redact.ts`), persistence (`store.ts`), the adapter API (`emitter.ts`), trace reconstruction/rollup/failure focus (`query.ts`) and ingress context (`context.ts`). The existing seams — `app.ts` (Fastify hooks + routes), `agent-service.ts` (Run lifecycle), `codex-runner.ts` / `container-codex-runner.ts` (runtime) — only *call the emitter*; nothing in the seams imports query or web code. Events are validated and redacted synchronously, appended asynchronously; a failing store never changes a Run's real outcome.

**Tech Stack:** Node 22, TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), Fastify 5, zod 4, vitest 4, ESM with `.js` import specifiers.

**Spec:** `docs/PRD.md` (GlassBox v2) — §6 FR-01…FR-11, §8 data contract, §9 degraded behaviour, §10 AC-01…AC-07. GitHub issues #21–#30 under epic #42.

## Global Constraints

- `schemaVersion` is the literal `"1.0"`; every API response carries `schemaVersion` and `capturePolicy`.
- Status enum exactly: `running | ok | error | cancelled | timeout | unset`. Categories exactly: `experience, control, runtime, model, tool, workspace, sandbox, policy, infrastructure`.
- Capture policy `metadata_only` (default) stores **no** `summary.text`; `safe_summary` stores bounded, redacted text; `full/raw` does not exist.
- Redaction runs **before** persistence, and on redactor error the event is persisted metadata-only with `privacy.reason = "redaction_failed_closed"`.
- Never emit an event for something not observed; if the Codex stream exposes no tool/model items, emit exactly one `capability.unavailable`.
- Telemetry must never throw into, block, or slow the Run path; store failure ⇒ `telemetry.degraded`, Run continues.
- Caps: 1,000 events/Run, 32 KB/event, 10 MB/Run; truncation recorded as `trace.truncated`.
- `sequence` is monotonic per trace; duplicate `eventId` is idempotent on append and on rebuild.
- Baseline preserved: existing tests in `apps/server/src/*.test.ts` keep passing unchanged (only `RunnerRequest` gains optional fields); `npm run check` green (Windows: the known `/tmp` path assertion is the only allowed failure).
- All new files: ESM, `.js` import extensions, colocated `*.test.ts`, no new npm dependencies. Paths in tests via `path.join`, never `/tmp/...` literals.
- Commits reference issues: `Refs #N` mid-task, `Closes #N` on the task's final commit. Run `npm run check` before any `Closes`.

## Dependency graph / parallel waves

```
Wave A (no deps, run in parallel):   T1 schema+context   T2 codex-stream fixture
Wave B (after T1, parallel):         T3 redact   T4 store   T5 query
Wave C (after T3+T4):                T6 emitter
Wave D (after T6):                   T7 wiring (config/types/index/app hooks) + AgentService adapter
Wave E (after T7, parallel):         T8 runner adapters (+ T2 fixture)   T9 query routes
Wave F (after T8+T9):                T10 failure fixture + integration/privacy/degradation tests
```

Each task is a fresh subagent with only this file, `docs/PRD.md`, and `CLAUDE.md` as context. Run `glassbox-privacy-reviewer` after T3, T6, T7, T8; `negative-test-writer` may be dispatched to extend T10.

## File structure

| File | Responsibility | Task |
|---|---|---|
| `apps/server/src/glassbox/schema.ts` | zod schema, enums, ID helpers, `EventInput` type | T1 |
| `apps/server/src/glassbox/context.ts` | `TraceContext` created at ingress | T1 |
| `apps/server/src/glassbox/redact.ts` | `redactEvent` (allowlist → key denylist → patterns → truncate), fail-closed wrapper | T3 |
| `apps/server/src/glassbox/store.ts` | `TraceStore` interface, `NdjsonTraceStore`, `MemoryTraceStore`, caps | T4 |
| `apps/server/src/glassbox/query.ts` | `buildTrace` (spans, rollup, failure focus, diagnosis) | T5 |
| `apps/server/src/glassbox/emitter.ts` | `ObservationEmitter` (sequence, validate, redact, enqueue, spans, degraded) | T6 |
| `apps/server/src/glassbox/codex-observer.ts` | maps Codex JSONL items → tool/workspace/model events, capability flag | T8 |
| `apps/server/src/config.ts` | `GLASSBOX_CAPTURE_POLICY`, `GLASSBOX_DEMO_FAILURE`, `traceDirectory` | T7 |
| `apps/server/src/types.ts` | `AgentRun.traceId`, `RunnerRequest.trace`, `RunnerRequest.timeoutMs` | T7 |
| `apps/server/src/index.ts` | construct store + emitter, pass to runner/service/app | T7 |
| `apps/server/src/app.ts` | `onRequest` context for message POST, `onResponse` root-span end, new routes | T7, T9 |
| `apps/server/src/agent-service.ts` | control-plane events, Run↔trace link, restart semantics, demo failure timeout | T7, T10 |
| `apps/server/src/codex-runner.ts`, `container-codex-runner.ts`, `runner-factory.ts` | runtime spans, sink into observer, `timeoutMs` override | T8 |
| `fixtures/codex-stream/*.jsonl`, `docs/CODEX_EVENTS.md` | real stream capture + mapping decision | T2 |
| `.env.example`, `README.md` | `GLASSBOX_*` documentation | T7, T10 |

---

### Task 1: Schema, IDs and trace context (#21)

**Files:**
- Create: `apps/server/src/glassbox/schema.ts`
- Create: `apps/server/src/glassbox/context.ts`
- Test: `apps/server/src/glassbox/schema.test.ts`

**Interfaces:**
- Produces: `SCHEMA_VERSION`, `observationEventSchema`, `eventInputSchema`, types `ObservationEvent`, `EventInput`, `TraceStatus`, `Category`, `EventType`, `CapturePolicy`; `newId(prefix)`; `EVENT_TYPES`, `STATUSES`, `CATEGORIES` arrays; `createTraceContext(init, capturePolicy)` and `TraceContext`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/src/glassbox/schema.test.ts
import { describe, expect, it } from "vitest";
import {
  CATEGORIES, EVENT_TYPES, SCHEMA_VERSION, STATUSES,
  eventInputSchema, newId, observationEventSchema,
} from "./schema.js";
import { createTraceContext } from "./context.js";

const base = {
  schemaVersion: SCHEMA_VERSION, eventId: "evt_1", sequence: 0,
  traceId: "trc_1", spanId: "spn_1", runId: "run-1", agentId: "agt-1",
  timestamp: "2026-08-26T00:00:00.000Z", type: "run.created", category: "control",
  name: "run.created", source: { component: "AgentService", observed: true },
  privacy: { redacted: false, rulesetVersion: "1" },
};

describe("ObservationEvent schema", () => {
  it("accepts a minimal valid event and fills defaults", () => {
    const parsed = observationEventSchema.parse(base);
    expect(parsed.status).toBe("unset");
    expect(parsed.phase).toBe("instant");
    expect(parsed.actorId).toBe("local-user");
    expect(parsed.attempt).toBe(1);
    expect(parsed.attributes).toEqual({});
  });
  it("rejects bad status, missing traceId and non-primitive attributes", () => {
    expect(() => observationEventSchema.parse({ ...base, status: "done" })).toThrow();
    expect(() => observationEventSchema.parse({ ...base, traceId: "" })).toThrow();
    expect(() => observationEventSchema.parse({ ...base, attributes: { nested: { a: 1 } } })).toThrow();
  });
  it("every taxonomy type and category is accepted", () => {
    for (const type of EVENT_TYPES) expect(() => observationEventSchema.parse({ ...base, type })).not.toThrow();
    for (const category of CATEGORIES) expect(() => observationEventSchema.parse({ ...base, category })).not.toThrow();
    expect(STATUSES).toEqual(["running", "ok", "error", "cancelled", "timeout", "unset"]);
  });
  it("eventInputSchema omits generated fields", () => {
    const input = eventInputSchema.parse({
      traceId: "trc_1", spanId: "spn_1", runId: "r", agentId: "a", type: "run.created",
      category: "control", name: "run.created", source: { component: "x", observed: true },
    });
    expect("eventId" in input).toBe(false);
    expect(input.status).toBe("unset");
  });
  it("newId prefixes and is unique", () => {
    const a = newId("evt"); const b = newId("evt");
    expect(a.startsWith("evt_")).toBe(true); expect(a).not.toBe(b); expect(a.length).toBeLessThanOrEqual(30);
  });
  it("createTraceContext binds ingress identifiers", () => {
    const ctx = createTraceContext({ requestId: "req-1", method: "POST", path: "/api/agents/x/messages" }, "metadata_only");
    expect(ctx.traceId.startsWith("trc_")).toBe(true);
    expect(ctx.rootSpanId.startsWith("spn_")).toBe(true);
    expect(ctx.actorId).toBe("local-user");
    expect(ctx.capturePolicy).toBe("metadata_only");
    expect(ctx.schemaVersion).toBe(SCHEMA_VERSION);
    expect(Date.parse(ctx.receivedAt)).not.toBeNaN();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @launchpad/server -- src/glassbox/schema.test.ts`
Expected: FAIL — cannot resolve `./schema.js`

- [ ] **Step 3: Write the schema**

```ts
// apps/server/src/glassbox/schema.ts
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const SCHEMA_VERSION = "1.0" as const;
export const REDACTION_RULESET_VERSION = "1" as const;

export const STATUSES = ["running", "ok", "error", "cancelled", "timeout", "unset"] as const;
export const CATEGORIES = [
  "experience", "control", "runtime", "model", "tool", "workspace", "sandbox", "policy", "infrastructure",
] as const;
export const EVENT_TYPES = [
  "run.created", "run.started", "run.completed", "run.failed", "run.cancelled", "run.timed_out",
  "http.request.received", "http.request.completed",
  "agent_service.run.started", "agent_service.run.completed", "agent_service.run.failed",
  "runtime.container.started", "runtime.container.stopped",
  "runtime.codex.started", "runtime.codex.completed", "runtime.codex.failed",
  "model.request", "model.completed",
  "tool.call.started", "tool.call.completed", "tool.call.failed",
  "workspace.changed", "policy.denied", "redaction.applied", "limit.exceeded",
  "error.recorded", "telemetry.degraded", "trace.truncated", "capability.unavailable",
] as const;
export const CAPTURE_POLICIES = ["metadata_only", "safe_summary"] as const;

export const statusSchema = z.enum(STATUSES);
export const categorySchema = z.enum(CATEGORIES);
export const eventTypeSchema = z.enum(EVENT_TYPES);
export const capturePolicySchema = z.enum(CAPTURE_POLICIES);

const primitive = z.union([z.string().max(2048), z.number(), z.boolean(), z.null()]);

export const observationEventSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  eventId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  traceId: z.string().min(1),
  spanId: z.string().min(1),
  parentSpanId: z.string().min(1).optional(),
  runId: z.string().min(1),
  agentId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  requestId: z.string().min(1).optional(),
  actorId: z.string().min(1).default("local-user"),
  actorType: z.enum(["human", "service", "agent", "controller"]).default("human"),
  attempt: z.number().int().positive().default(1),
  timestamp: z.string().datetime(),
  type: eventTypeSchema,
  category: categorySchema,
  phase: z.enum(["start", "end", "instant"]).default("instant"),
  status: statusSchema.default("unset"),
  name: z.string().min(1).max(120),
  durationMs: z.number().nonnegative().optional(),
  source: z.object({
    component: z.string().min(1).max(64),
    adapter: z.string().min(1).max(64).optional(),
    observed: z.boolean(),
  }),
  attributes: z.record(z.string().max(64), primitive).default({}),
  summary: z.object({ text: z.string().max(4096), policy: z.literal("safe_summary") }).optional(),
  error: z.object({ type: z.string().max(64), message: z.string().max(2048) }).optional(),
  privacy: z.object({
    redacted: z.boolean(),
    rulesetVersion: z.string(),
    reason: z.string().max(64).optional(),
    rules: z.array(z.string()).optional(),
    originalBytes: z.number().int().nonnegative().optional(),
    storedBytes: z.number().int().nonnegative().optional(),
  }),
});

export const eventInputSchema = observationEventSchema.omit({
  schemaVersion: true, eventId: true, sequence: true, timestamp: true, privacy: true,
}).extend({ timestamp: z.string().datetime().optional() });

export type ObservationEvent = z.infer<typeof observationEventSchema>;
export type EventInput = z.input<typeof eventInputSchema>;
export type TraceStatus = z.infer<typeof statusSchema>;
export type Category = z.infer<typeof categorySchema>;
export type EventType = z.infer<typeof eventTypeSchema>;
export type CapturePolicy = z.infer<typeof capturePolicySchema>;

export function newId(prefix: "trc" | "spn" | "evt"): string {
  return prefix + "_" + randomUUID().replace(/-/g, "").slice(0, 20);
}
```

```ts
// apps/server/src/glassbox/context.ts
import { SCHEMA_VERSION, newId, type CapturePolicy } from "./schema.js";

export interface TraceContext {
  traceId: string;
  rootSpanId: string;
  requestId?: string | undefined;
  method?: string | undefined;
  path?: string | undefined;
  actorId: string;
  actorType: "human" | "service" | "agent" | "controller";
  capturePolicy: CapturePolicy;
  schemaVersion: typeof SCHEMA_VERSION;
  receivedAt: string;
  /** Filled by AgentService once the Run exists, so the ingress hook can end the root span. */
  runId?: string | undefined;
  agentId?: string | undefined;
}

export function createTraceContext(
  init: { requestId?: string | undefined; method?: string | undefined; path?: string | undefined; actorId?: string | undefined },
  capturePolicy: CapturePolicy,
): TraceContext {
  return {
    traceId: newId("trc"),
    rootSpanId: newId("spn"),
    requestId: init.requestId,
    method: init.method,
    path: init.path,
    actorId: init.actorId ?? "local-user",
    actorType: "human",
    capturePolicy,
    schemaVersion: SCHEMA_VERSION,
    receivedAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @launchpad/server -- src/glassbox/schema.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
```bash
git add apps/server/src/glassbox/schema.ts apps/server/src/glassbox/context.ts apps/server/src/glassbox/schema.test.ts
git commit -m "feat(glassbox): ObservationEvent schema, IDs, trace context

Closes #21"
```

---

### Task 2: Capture a real Codex `--json` stream fixture and record the mapping (#24)

**Files:**
- Create: `fixtures/codex-stream/README.md`, `fixtures/codex-stream/codex-<version>.jsonl` (one per version captured)
- Create: `docs/CODEX_EVENTS.md`
- Modify: `apps/server/src/codex-runner.test.ts` (add a fixture-driven parse test)

**Interfaces:**
- Produces: the fixture files and `docs/CODEX_EVENTS.md` table that Task 8 reads to decide which stream items become `tool.call.*`, `workspace.changed`, `model.completed`.

- [ ] **Step 1: Capture the stream on the host (Codex 0.142.x)**

From the repo root, with `.env` loaded (`set -a; . ./.env; set +a`; on Windows use the `CODEX_BIN` path from `.env`):

```bash
mkdir -p fixtures/codex-stream .local/capture && cd .local/capture
"$CODEX_BIN" exec --json --sandbox workspace-write --skip-git-repo-check -C "$PWD" -- \
  "Create hello.txt containing the word hello, then run: cat hello.txt" > ../../fixtures/codex-stream/raw-host.jsonl 2>../../fixtures/codex-stream/raw-host.stderr
cd ../..
```

- [ ] **Step 2: Capture the stream inside the Docker Runtime image (Codex 0.111.0)**

```bash
docker run --rm -v "$PWD/.local/capture:/workspace" -e ARK_API_KEY -e CODEX_HOME=/tmp/ch -e HOME=/tmp \
  volc-agent-runtime:local sh -c 'mkdir -p /tmp/ch && printf "%s\n" "model = \"$ARK_MODEL\"" "model_provider = \"volcengine_ark\"" "" "[model_providers.volcengine_ark]" "name = \"Volcengine Ark\"" "base_url = \"$ARK_BASE_URL\"" "env_key = \"ARK_API_KEY\"" "wire_api = \"responses\"" "requires_openai_auth = false" > /tmp/ch/config.toml && codex --version && codex exec --json --sandbox workspace-write --skip-git-repo-check -C /workspace -- "Create hello.txt containing the word hello, then run: cat hello.txt"' \
  > fixtures/codex-stream/raw-docker.jsonl 2>fixtures/codex-stream/raw-docker.stderr
```
(`ARK_MODEL`/`ARK_BASE_URL` must be exported; if the image is missing, run `/run-poc` once to build it.)

- [ ] **Step 3: Scrub and rename**

```bash
node -e '
const fs=require("fs");
for (const [src,dst] of [["raw-host","codex-0.142"],["raw-docker","codex-0.111"]]) {
  const p=`fixtures/codex-stream/${src}.jsonl`; if(!fs.existsSync(p)) continue;
  let t=fs.readFileSync(p,"utf8");
  t=t.replace(/ark-[0-9a-f-]{30,}/g,"ark-REDACTED").replace(/sk-[A-Za-z0-9_-]{20,}/g,"sk-REDACTED").replace(/C:\\\\Users\\\\[^\\\\"]+/g,"C:\\\\Users\\\\USER");
  fs.writeFileSync(`fixtures/codex-stream/${dst}.jsonl`,t); fs.unlinkSync(p); fs.rmSync(`fixtures/codex-stream/${src}.stderr`,{force:true});
}'
grep -c "" fixtures/codex-stream/*.jsonl
grep -oE '"type":"[a-z_.]+"' fixtures/codex-stream/*.jsonl | sort | uniq -c
grep -oE '"item":\{"type":"[a-z_]+"' fixtures/codex-stream/*.jsonl | sort | uniq -c
```

- [ ] **Step 4: Write `docs/CODEX_EVENTS.md`**

Fill this table from the `uniq -c` output — **only rows you actually saw**, with one verbatim (scrubbed) example line each:

```markdown
# Codex CLI `--json` event stream (observed)

| Version | Top-level `type` | `item.type` | Fields seen | GlassBox mapping | Evidence state |
|---|---|---|---|---|---|
| 0.111 / 0.142 | thread.started | — | thread_id | sessionId backfill | observed |
| … | item.completed | command_execution | command, exit_code, aggregated_output?, status | tool.call.completed / tool.call.failed (exit≠0) | observed |
| … | item.completed | file_change | changes[] {path, kind} | workspace.changed | observed |
| … | item.completed | agent_message | text | (final output; NOT stored as content) | observed |
| … | item.completed | reasoning | summary/text | **dropped — no chain-of-thought** | n/a |
| … | turn.completed | — | usage.{input_tokens,cached_input_tokens,output_tokens} | model.completed (usage attrs) | observed |
| … | error / turn.failed | — | message | runtime.codex.failed error | observed |

If a version emits **no** `command_execution`/`file_change` items and no `turn.completed.usage`, the runner must emit one `capability.unavailable` (PRD AC-04).
```

- [ ] **Step 5: Add a fixture-driven parser test**

Append to `apps/server/src/codex-runner.test.ts`:

```ts
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

describe("Codex stream fixtures", () => {
  const dir = path.join(process.cwd(), "..", "..", "fixtures", "codex-stream");
  const files = ["codex-0.111.jsonl", "codex-0.142.jsonl"].map((f) => path.join(dir, f)).filter(existsSync);
  it.each(files)("parses %s to a thread id, a final message and usage", (file) => {
    const parsed = { messages: [] as string[], threadId: null as string | null, usage: null as null | object, errors: [] as string[] };
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) if (line.trim()) parseCodexEventLine(line, parsed);
    expect(parsed.threadId).toBeTruthy();
    expect(parsed.messages.length).toBeGreaterThan(0);
    expect(parsed.usage).not.toBeNull();
  });
});
```
(vitest runs with cwd `apps/server`, hence the `../..`.)

- [ ] **Step 6: Run, verify, commit**

Run: `npm run test -w @launchpad/server -- src/codex-runner.test.ts` → PASS.
Run the secret scan the commit hook performs: `git add fixtures docs/CODEX_EVENTS.md apps/server/src/codex-runner.test.ts && git commit -m "chore(glassbox): capture real Codex --json stream fixtures and mapping table

Closes #24"` — the pre-commit hook blocks if any key pattern survived scrubbing; fix and retry.

---

### Task 3: Redaction pipeline (#29)

**Files:**
- Create: `apps/server/src/glassbox/redact.ts`
- Test: `apps/server/src/glassbox/redact.test.ts`

**Interfaces:**
- Consumes: `ObservationEvent`, `CapturePolicy`, `REDACTION_RULESET_VERSION` from `./schema.js`.
- Produces: `redactEvent(event, options): ObservationEvent` (pure), `redactText(text, extra?): { text: string; rules: string[] }`, `RedactOptions { policy: CapturePolicy; extraPatterns?: RegExp[]; maxSummaryChars?: number }`, `failClosed(event): ObservationEvent`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/src/glassbox/redact.test.ts
import { describe, expect, it } from "vitest";
import { failClosed, redactEvent, redactText } from "./redact.js";
import { SCHEMA_VERSION, type ObservationEvent } from "./schema.js";

// Built at runtime so no key-shaped literal is ever committed (GitHub push protection scans file contents).
const FAKE_ARK = ["ark", "0f0f0f0f", "1a1a", "4b4b", "8c8c", "d0d0d0d0d0d0", "0abc1"].join("-");
const ev = (over: Partial<ObservationEvent>): ObservationEvent => ({
  schemaVersion: SCHEMA_VERSION, eventId: "evt_1", sequence: 1, traceId: "trc_1", spanId: "spn_1",
  runId: "r", agentId: "a", actorId: "local-user", actorType: "human", attempt: 1,
  timestamp: "2026-08-26T00:00:00.000Z", type: "tool.call.completed", category: "tool", phase: "instant",
  status: "ok", name: "shell", source: { component: "AgentRunner", observed: true }, attributes: {},
  privacy: { redacted: false, rulesetVersion: "1" }, ...over,
});

describe("redactText", () => {
  it.each([
    ["openai key", "token sk-proj-abcdefghijklmnopqrstuvwxyz0123456789 here", "openai_key"],
    ["ark key", "ARK " + FAKE_ARK, "ark_key"],
    ["bearer", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz.123456", "bearer"],
    ["volc ak", "AKLTabcdefghijklmnopqrstuvwxyz12", "volc_ak"],
    ["private key", "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----", "private_key"],
    ["credential url", "postgres://user:hunter2@db.internal/x", "credential_url"],
    ["env assignment", "OPENAI_API_KEY=abc123def456", "env_assignment"],
  ])("redacts %s", (_n, input, rule) => {
    const out = redactText(input);
    expect(out.rules).toContain(rule);
    expect(out.text).not.toContain(input.split(/\s+/).at(-1)!.slice(-8));
    expect(out.text).toContain("[REDACTED:" + rule + "]");
  });
  it("leaves near misses alone", () => {
    for (const s of ["sk-short", "ark-not-a-uuid", "Bearer", "https://example.com/path", "KEY=1"]) {
      expect(redactText(s)).toEqual({ text: s, rules: [] });
    }
  });
  it("applies extra patterns (seeded fixtures)", () => {
    expect(redactText("CANARY-SECRET-42 present", [/CANARY-SECRET-\d+/g]).text).toBe("[REDACTED:custom] present");
  });
});

describe("redactEvent", () => {
  it("drops denylisted keys case-insensitively and scans remaining strings", () => {
    const out = redactEvent(ev({ attributes: { Authorization: "x", api_key: "y", command: "curl -H 'Bearer abcdefghijklmnopqrstuvwxyz' u", exitCode: 0 } }), { policy: "safe_summary" });
    expect(out.attributes).not.toHaveProperty("Authorization");
    expect(out.attributes).not.toHaveProperty("api_key");
    expect(out.attributes.command).toContain("[REDACTED:bearer]");
    expect(out.attributes.exitCode).toBe(0);
    expect(out.privacy.redacted).toBe(true);
    expect(out.privacy.rules).toEqual(expect.arrayContaining(["denylist_key", "bearer"]));
  });
  it("metadata_only strips summary entirely; safe_summary truncates and counts bytes", () => {
    const long = "x".repeat(5000);
    const meta = redactEvent(ev({ summary: { text: long, policy: "safe_summary" } }), { policy: "metadata_only" });
    expect(meta.summary).toBeUndefined();
    const safe = redactEvent(ev({ summary: { text: long, policy: "safe_summary" } }), { policy: "safe_summary", maxSummaryChars: 1000 });
    expect(safe.summary?.text.length).toBe(1000);
    expect(safe.privacy.originalBytes).toBe(5000);
    expect(safe.privacy.storedBytes).toBe(1000);
    expect(safe.privacy.rules).toContain("truncated");
  });
  it("scans error messages under every policy", () => {
    const out = redactEvent(ev({ error: { type: "exit", message: "failed with " + FAKE_ARK } }), { policy: "metadata_only" });
    expect(out.error?.message).not.toContain("0f0f0f0f");
  });
  it("is pure", () => {
    const input = ev({ attributes: { token: "t" } });
    redactEvent(input, { policy: "metadata_only" });
    expect(input.attributes.token).toBe("t");
  });
  it("failClosed keeps identifiers and drops content", () => {
    const out = failClosed(ev({ attributes: { command: "secret" }, summary: { text: "s", policy: "safe_summary" }, error: { type: "e", message: "m" } }));
    expect(out.attributes).toEqual({});
    expect(out.summary).toBeUndefined();
    expect(out.error).toEqual({ type: "e", message: "[REDACTED:failed_closed]" });
    expect(out.privacy).toMatchObject({ redacted: true, reason: "redaction_failed_closed" });
    expect(out.traceId).toBe("trc_1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @launchpad/server -- src/glassbox/redact.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// apps/server/src/glassbox/redact.ts
import { REDACTION_RULESET_VERSION, type CapturePolicy, type ObservationEvent } from "./schema.js";

export interface RedactOptions {
  policy: CapturePolicy;
  extraPatterns?: RegExp[] | undefined;
  maxSummaryChars?: number | undefined;
}

const DENY_KEY = /^(authorization|api[_-]?key|token|secret|password|cookie|private[_-]?key)$/i;

const PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ["bearer", /Bearer\s+[A-Za-z0-9._~+/-]{16,}=*/g],
  ["openai_key", /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g],
  ["ark_key", /ark-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-[0-9a-f]+)?/g],
  ["volc_ak", /AKLT[A-Za-z0-9]{20,}/g],
  ["credential_url", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi],
  ["env_assignment", /\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*\S{6,}/g],
];

export function redactText(text: string, extra: RegExp[] = []): { text: string; rules: string[] } {
  const rules = new Set<string>();
  let out = text;
  for (const [rule, re] of PATTERNS) {
    if (re.test(out)) { rules.add(rule); out = out.replace(re, "[REDACTED:" + rule + "]"); }
    re.lastIndex = 0;
  }
  for (const re of extra) {
    const g = re.global ? re : new RegExp(re.source, re.flags + "g");
    if (g.test(out)) { rules.add("custom"); out = out.replace(g, "[REDACTED:custom]"); }
    g.lastIndex = 0;
  }
  return { text: out, rules: [...rules] };
}

export function redactEvent(event: ObservationEvent, options: RedactOptions): ObservationEvent {
  const rules = new Set<string>();
  const extra = options.extraPatterns ?? [];
  const attributes: ObservationEvent["attributes"] = {};
  for (const [key, value] of Object.entries(event.attributes)) {
    if (DENY_KEY.test(key)) { rules.add("denylist_key"); continue; }
    if (typeof value === "string") {
      const r = redactText(value, extra); r.rules.forEach((x) => rules.add(x)); attributes[key] = r.text;
    } else attributes[key] = value;
  }
  const out: ObservationEvent = { ...event, attributes, privacy: { ...event.privacy, rulesetVersion: REDACTION_RULESET_VERSION } };
  if (event.error) {
    const r = redactText(event.error.message, extra); r.rules.forEach((x) => rules.add(x));
    out.error = { type: event.error.type, message: r.text.slice(0, 2048) };
  }
  if (event.summary) {
    if (options.policy !== "safe_summary") { delete out.summary; rules.add("policy_drop_summary"); }
    else {
      const max = options.maxSummaryChars ?? 4096;
      const r = redactText(event.summary.text, extra); r.rules.forEach((x) => rules.add(x));
      const original = Buffer.byteLength(event.summary.text, "utf8");
      const text = r.text.length > max ? r.text.slice(0, max) : r.text;
      if (text.length < r.text.length) rules.add("truncated");
      out.summary = { text, policy: "safe_summary" };
      out.privacy = { ...out.privacy, originalBytes: original, storedBytes: Buffer.byteLength(text, "utf8") };
    }
  }
  if (rules.size > 0) out.privacy = { ...out.privacy, redacted: true, rules: [...rules] };
  return out;
}

/** Used by the emitter when redactEvent throws: keep identifiers/timing/status, drop all content. */
export function failClosed(event: ObservationEvent): ObservationEvent {
  const out: ObservationEvent = {
    ...event, attributes: {},
    privacy: { redacted: true, rulesetVersion: REDACTION_RULESET_VERSION, reason: "redaction_failed_closed" },
  };
  delete out.summary;
  if (event.error) out.error = { type: event.error.type, message: "[REDACTED:failed_closed]" };
  return out;
}
```

- [ ] **Step 4: Run tests → PASS. Typecheck. Commit**

```bash
git add apps/server/src/glassbox/redact.ts apps/server/src/glassbox/redact.test.ts
git commit -m "feat(glassbox): redaction pipeline with fail-closed fallback

Refs #29"
```
(Task 10 closes #29 after the cross-surface privacy test.)

---

### Task 4: TraceStore — NDJSON per Run, rebuildable index, caps (#22)

**Files:**
- Create: `apps/server/src/glassbox/store.ts`
- Test: `apps/server/src/glassbox/store.test.ts`

**Interfaces:**
- Consumes: `ObservationEvent`, `observationEventSchema` from `./schema.js`.
- Produces:
```ts
export interface RunIndexEntry { runId: string; traceId: string; agentId: string; eventCount: number; lastSequence: number; lastTimestamp: string; bytes: number; truncated: boolean }
export type AppendResult = { stored: true } | { stored: false; reason: "duplicate" | "cap_events" | "cap_bytes" };
export interface TraceStore {
  initialize(): Promise<void>;
  append(event: ObservationEvent): Promise<AppendResult>;
  readRun(runId: string): Promise<ObservationEvent[]>;      // sorted by sequence
  runIdForTrace(traceId: string): string | undefined;
  listRuns(): RunIndexEntry[];                              // newest lastTimestamp first
  markTruncated(runId: string): void;
}
export const TRACE_CAPS = { maxEventsPerRun: 1000, maxEventBytes: 32 * 1024, maxRunBytes: 10 * 1024 * 1024 } as const;
export const ALWAYS_KEEP_TYPES: ReadonlySet<string>;      // terminal / error / system events that bypass the events cap
export class NdjsonTraceStore implements TraceStore { constructor(directory: string) }
export class MemoryTraceStore implements TraceStore { constructor() }
export function shrinkToCap(event: ObservationEvent): ObservationEvent;  // strips attributes+summary if > maxEventBytes
```

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/src/glassbox/store.test.ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION, type ObservationEvent } from "./schema.js";
import { ALWAYS_KEEP_TYPES, MemoryTraceStore, NdjsonTraceStore, TRACE_CAPS, shrinkToCap } from "./store.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
async function tmp(): Promise<string> { const d = await mkdtemp(path.join(tmpdir(), "glassbox-store-")); dirs.push(d); return d; }

const ev = (sequence: number, over: Partial<ObservationEvent> = {}): ObservationEvent => ({
  schemaVersion: SCHEMA_VERSION, eventId: "evt_" + sequence, sequence, traceId: "trc_1", spanId: "spn_" + sequence,
  runId: "run-1", agentId: "agt-1", actorId: "local-user", actorType: "human", attempt: 1,
  timestamp: new Date(1_700_000_000_000 + sequence).toISOString(), type: "tool.call.completed", category: "tool",
  phase: "instant", status: "ok", name: "t" + sequence, source: { component: "AgentRunner", observed: true },
  attributes: {}, privacy: { redacted: false, rulesetVersion: "1" }, ...over,
});

describe.each([
  ["NdjsonTraceStore", async () => new NdjsonTraceStore(path.join(await tmp(), "traces"))],
  ["MemoryTraceStore", async () => new MemoryTraceStore()],
])("%s", (_name, make) => {
  it("appends, reads in sequence order, and ignores duplicate eventIds", async () => {
    const store = await make(); await store.initialize();
    expect(await store.append(ev(2))).toEqual({ stored: true });
    expect(await store.append(ev(1))).toEqual({ stored: true });
    expect(await store.append(ev(2))).toEqual({ stored: false, reason: "duplicate" });
    const events = await store.readRun("run-1");
    expect(events.map((e) => e.sequence)).toEqual([1, 2]);
    expect(store.listRuns()[0]).toMatchObject({ runId: "run-1", traceId: "trc_1", eventCount: 2, lastSequence: 2, truncated: false });
    expect(store.runIdForTrace("trc_1")).toBe("run-1");
  });
  it("enforces the per-run event cap but always keeps terminal/error events", async () => {
    const store = await make(); await store.initialize();
    for (let i = 1; i <= TRACE_CAPS.maxEventsPerRun; i++) await store.append(ev(i));
    expect(await store.append(ev(9001))).toEqual({ stored: false, reason: "cap_events" });
    expect(await store.append(ev(9002, { type: "run.failed", category: "control", status: "error" }))).toEqual({ stored: true });
    expect(ALWAYS_KEEP_TYPES.has("run.failed")).toBe(true);
    expect((await store.readRun("run-1")).length).toBe(TRACE_CAPS.maxEventsPerRun + 1);
  });
});

describe("NdjsonTraceStore persistence", () => {
  it("rebuilds the index from files on initialize and dedups duplicates in the file", async () => {
    const dir = path.join(await tmp(), "traces");
    const a = new NdjsonTraceStore(dir); await a.initialize();
    await a.append(ev(1)); await a.append(ev(2));
    // simulate a duplicate line written by a crash/retry
    const file = path.join(dir, "run-1.ndjson");
    await writeFile(file, (await readFile(file, "utf8")) + JSON.stringify(ev(2)) + "\n");
    const b = new NdjsonTraceStore(dir); await b.initialize();
    expect((await b.readRun("run-1")).length).toBe(2);
    expect(b.listRuns()).toEqual(a.listRuns());
  });
  it("ignores a corrupt line without losing the rest", async () => {
    const dir = path.join(await tmp(), "traces");
    const a = new NdjsonTraceStore(dir); await a.initialize(); await a.append(ev(1));
    await writeFile(path.join(dir, "run-1.ndjson"), (await readFile(path.join(dir, "run-1.ndjson"), "utf8")) + "{not json\n");
    const b = new NdjsonTraceStore(dir); await b.initialize();
    expect((await b.readRun("run-1")).length).toBe(1);
  });
  it("append p95 stays under 20ms for 100 events", async () => {
    const store = new NdjsonTraceStore(path.join(await tmp(), "traces")); await store.initialize();
    const times: number[] = [];
    for (let i = 1; i <= 100; i++) { const t = performance.now(); await store.append(ev(i)); times.push(performance.now() - t); }
    times.sort((x, y) => x - y);
    expect(times[Math.floor(times.length * 0.95)]!).toBeLessThan(20);
  });
});

describe("shrinkToCap", () => {
  it("strips attributes and summary when serialized size exceeds 32KB", () => {
    const big = ev(1, { attributes: { blob: "x".repeat(2000) }, summary: { text: "y".repeat(4096), policy: "safe_summary" } });
    const many: Record<string, string> = {}; for (let i = 0; i < 40; i++) many["k" + i] = "v".repeat(1000);
    const huge = { ...big, attributes: many };
    const out = shrinkToCap(huge);
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(TRACE_CAPS.maxEventBytes);
    expect(out.attributes).toEqual({});
    expect(out.privacy.reason).toBe("event_truncated");
    expect(shrinkToCap(ev(2))).toEqual(ev(2));
  });
});
```

- [ ] **Step 2: Run → FAIL (module missing)**

- [ ] **Step 3: Implement**

```ts
// apps/server/src/glassbox/store.ts
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { observationEventSchema, type ObservationEvent } from "./schema.js";

export const TRACE_CAPS = { maxEventsPerRun: 1000, maxEventBytes: 32 * 1024, maxRunBytes: 10 * 1024 * 1024 } as const;

export const ALWAYS_KEEP_TYPES: ReadonlySet<string> = new Set([
  "run.completed", "run.failed", "run.cancelled", "run.timed_out",
  "agent_service.run.completed", "agent_service.run.failed",
  "runtime.codex.completed", "runtime.codex.failed", "runtime.container.stopped",
  "error.recorded", "telemetry.degraded", "trace.truncated", "capability.unavailable", "limit.exceeded",
]);

export interface RunIndexEntry {
  runId: string; traceId: string; agentId: string; eventCount: number;
  lastSequence: number; lastTimestamp: string; bytes: number; truncated: boolean;
}
export type AppendResult = { stored: true } | { stored: false; reason: "duplicate" | "cap_events" | "cap_bytes" };

export interface TraceStore {
  initialize(): Promise<void>;
  append(event: ObservationEvent): Promise<AppendResult>;
  readRun(runId: string): Promise<ObservationEvent[]>;
  runIdForTrace(traceId: string): string | undefined;
  listRuns(): RunIndexEntry[];
  markTruncated(runId: string): void;
}

export function shrinkToCap(event: ObservationEvent): ObservationEvent {
  if (Buffer.byteLength(JSON.stringify(event), "utf8") <= TRACE_CAPS.maxEventBytes) return event;
  const out: ObservationEvent = { ...event, attributes: {}, privacy: { ...event.privacy, redacted: true, reason: "event_truncated" } };
  delete out.summary;
  return out;
}

const keepAlways = (e: ObservationEvent) => ALWAYS_KEEP_TYPES.has(e.type) || e.status === "error" || e.status === "timeout" || e.status === "cancelled";

/** Shared index/cap logic; subclasses only implement raw persistence. */
abstract class BaseTraceStore implements TraceStore {
  protected readonly index = new Map<string, RunIndexEntry>();
  protected readonly seen = new Map<string, Set<string>>();
  protected readonly traceToRun = new Map<string, string>();

  abstract initialize(): Promise<void>;
  protected abstract persist(event: ObservationEvent, line: string): Promise<void>;
  abstract readRun(runId: string): Promise<ObservationEvent[]>;

  protected admit(event: ObservationEvent): AppendResult | ObservationEvent {
    const ids = this.seen.get(event.runId) ?? new Set<string>();
    if (ids.has(event.eventId)) return { stored: false, reason: "duplicate" };
    const entry = this.index.get(event.runId);
    if (entry && !keepAlways(event)) {
      if (entry.eventCount >= TRACE_CAPS.maxEventsPerRun) return { stored: false, reason: "cap_events" };
      if (entry.bytes >= TRACE_CAPS.maxRunBytes) return { stored: false, reason: "cap_bytes" };
    }
    return shrinkToCap(event);
  }

  protected track(event: ObservationEvent, bytes: number): void {
    const ids = this.seen.get(event.runId) ?? new Set<string>(); ids.add(event.eventId); this.seen.set(event.runId, ids);
    const prev = this.index.get(event.runId);
    this.index.set(event.runId, {
      runId: event.runId, traceId: event.traceId, agentId: event.agentId,
      eventCount: (prev?.eventCount ?? 0) + 1,
      lastSequence: Math.max(prev?.lastSequence ?? -1, event.sequence),
      lastTimestamp: prev && prev.lastTimestamp > event.timestamp ? prev.lastTimestamp : event.timestamp,
      bytes: (prev?.bytes ?? 0) + bytes, truncated: prev?.truncated ?? false,
    });
    this.traceToRun.set(event.traceId, event.runId);
  }

  async append(event: ObservationEvent): Promise<AppendResult> {
    const admitted = this.admit(event);
    if ("stored" in admitted) return admitted;
    const line = JSON.stringify(admitted) + "\n";
    await this.persist(admitted, line);
    this.track(admitted, Buffer.byteLength(line, "utf8"));
    return { stored: true };
  }
  runIdForTrace(traceId: string): string | undefined { return this.traceToRun.get(traceId); }
  listRuns(): RunIndexEntry[] { return [...this.index.values()].sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp)); }
  markTruncated(runId: string): void { const e = this.index.get(runId); if (e) e.truncated = true; }
}

export class MemoryTraceStore extends BaseTraceStore {
  private readonly events = new Map<string, ObservationEvent[]>();
  async initialize(): Promise<void> {}
  protected async persist(event: ObservationEvent): Promise<void> {
    const list = this.events.get(event.runId) ?? []; list.push(event); this.events.set(event.runId, list);
  }
  async readRun(runId: string): Promise<ObservationEvent[]> {
    return [...(this.events.get(runId) ?? [])].sort((a, b) => a.sequence - b.sequence);
  }
}

export class NdjsonTraceStore extends BaseTraceStore {
  constructor(private readonly directory: string) { super(); }
  private file(runId: string): string { return path.join(this.directory, runId.replace(/[^a-zA-Z0-9_-]/g, "_") + ".ndjson"); }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    this.index.clear(); this.seen.clear(); this.traceToRun.clear();
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith(".ndjson")) continue;
      for (const event of await this.parseFile(path.join(this.directory, name))) {
        const ids = this.seen.get(event.runId);
        if (ids?.has(event.eventId)) continue;
        this.track(event, Buffer.byteLength(JSON.stringify(event) + "\n", "utf8"));
      }
    }
  }
  private async parseFile(file: string): Promise<ObservationEvent[]> {
    let raw = "";
    try { raw = await readFile(file, "utf8"); } catch { return []; }
    const out: ObservationEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { const parsed = observationEventSchema.safeParse(JSON.parse(line)); if (parsed.success) out.push(parsed.data); } catch { /* corrupt line: skip */ }
    }
    return out;
  }
  protected async persist(event: ObservationEvent, line: string): Promise<void> {
    await appendFile(this.file(event.runId), line, { encoding: "utf8", mode: 0o600 });
  }
  async readRun(runId: string): Promise<ObservationEvent[]> {
    const seen = new Set<string>();
    return (await this.parseFile(this.file(runId)))
      .filter((e) => (seen.has(e.eventId) ? false : (seen.add(e.eventId), true)))
      .sort((a, b) => a.sequence - b.sequence);
  }
}
```

- [ ] **Step 4: Run → PASS. Typecheck. Commit**

```bash
git add apps/server/src/glassbox/store.ts apps/server/src/glassbox/store.test.ts
git commit -m "feat(glassbox): NDJSON TraceStore with rebuildable index, dedup and caps

Closes #22"
```

---

### Task 5: Query service — spans, rollup, failure focus, diagnosis (#27 core)

**Files:**
- Create: `apps/server/src/glassbox/query.ts`
- Test: `apps/server/src/glassbox/query.test.ts`

**Interfaces:**
- Consumes: `ObservationEvent`, `TraceStatus`, `Category`, `CapturePolicy`, `SCHEMA_VERSION` from `./schema.js`.
- Produces:
```ts
export interface Span { spanId: string; parentSpanId?: string | undefined; name: string; category: Category; status: TraceStatus;
  startedAt: string; endedAt?: string | undefined; durationMs?: number | undefined; incomplete: boolean; sequence: number;
  source: ObservationEvent["source"]; attributes: ObservationEvent["attributes"]; summary?: ObservationEvent["summary"];
  error?: ObservationEvent["error"]; events: ObservationEvent[]; children: Span[]; depth: number }
export interface FailureFocus { kind: "error" | "timeout" | "cancelled" | "degraded"; spanId: string; eventId: string; sequence: number;
  name: string; category: Category; component: string; message?: string | undefined; path: string[]; diagnosis: string }
export interface TraceSummary { schemaVersion: "1.0"; capturePolicy: CapturePolicy; runId: string; traceId: string; agentId: string;
  sessionId?: string | undefined; status: TraceStatus; startedAt?: string | undefined; endedAt?: string | undefined; durationMs?: number | undefined;
  eventCount: number; spanCount: number; incompleteSpans: number; redactedEvents: number; degraded: boolean; truncated: boolean;
  usage?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number } | undefined;
  capabilities: { model: "observed" | "unavailable"; tool: "observed" | "unavailable" }; firstFailingStep?: string | undefined; failure?: FailureFocus | undefined }
export interface TraceView { summary: TraceSummary; spans: Span[]; events: ObservationEvent[] }
export function buildTrace(events: ObservationEvent[], opts: { capturePolicy: CapturePolicy; degraded?: boolean; truncated?: boolean }): TraceView
export function flattenSpans(spans: Span[]): Span[]   // pre-order
```

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/src/glassbox/query.test.ts
import { describe, expect, it } from "vitest";
import { buildTrace, flattenSpans } from "./query.js";
import { SCHEMA_VERSION, type ObservationEvent } from "./schema.js";

let seq = 0;
const t = (ms: number) => new Date(1_700_000_000_000 + ms).toISOString();
const ev = (over: Partial<ObservationEvent> & Pick<ObservationEvent, "type" | "category" | "spanId">): ObservationEvent => ({
  schemaVersion: SCHEMA_VERSION, eventId: "evt_" + ++seq, sequence: seq, traceId: "trc_1", runId: "run-1", agentId: "agt-1",
  actorId: "local-user", actorType: "human", attempt: 1, timestamp: t(seq * 10), phase: "instant", status: "unset",
  name: over.type, source: { component: "test", observed: true }, attributes: {}, privacy: { redacted: false, rulesetVersion: "1" }, ...over,
});
const root = () => ev({ type: "http.request.received", category: "control", spanId: "root", phase: "start", status: "running" });
const svcStart = () => ev({ type: "agent_service.run.started", category: "control", spanId: "svc", parentSpanId: "root", phase: "start", status: "running" });
const rtStart = () => ev({ type: "runtime.codex.started", category: "runtime", spanId: "rt", parentSpanId: "svc", phase: "start", status: "running", source: { component: "AgentRunner", observed: true } });

describe("buildTrace", () => {
  it("reconstructs a nested tree with durations and rolls up ok", () => {
    seq = 0;
    const events = [
      root(), ev({ type: "run.created", category: "control", spanId: "rc", parentSpanId: "root" }), svcStart(), rtStart(),
      ev({ type: "tool.call.completed", category: "tool", spanId: "tool1", parentSpanId: "rt", status: "ok", durationMs: 5 }),
      ev({ type: "model.completed", category: "model", spanId: "m1", parentSpanId: "rt", status: "ok", attributes: { inputTokens: 10, outputTokens: 2 } }),
      ev({ type: "runtime.codex.completed", category: "runtime", spanId: "rt", phase: "end", status: "ok" }),
      ev({ type: "run.completed", category: "control", spanId: "rdone", parentSpanId: "svc", status: "ok" }),
      ev({ type: "agent_service.run.completed", category: "control", spanId: "svc", phase: "end", status: "ok" }),
      ev({ type: "http.request.completed", category: "control", spanId: "root", phase: "end", status: "ok" }),
    ];
    const view = buildTrace(events, { capturePolicy: "metadata_only" });
    expect(view.summary.status).toBe("ok");
    expect(view.summary.spanCount).toBe(6);
    expect(view.summary.incompleteSpans).toBe(0);
    expect(view.summary.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect(view.summary.capabilities).toEqual({ model: "observed", tool: "observed" });
    expect(view.spans[0]!.spanId).toBe("root");
    const rt = flattenSpans(view.spans).find((s) => s.spanId === "rt")!;
    expect(rt.depth).toBe(2); expect(rt.durationMs).toBe(30); expect(rt.children.map((c) => c.spanId)).toEqual(["tool1", "m1"]);
    expect(view.summary.failure).toBeUndefined();
  });
  it("timeout: focuses the runtime span, not the later control failure", () => {
    seq = 0;
    const events = [root(), svcStart(), rtStart(),
      ev({ type: "runtime.codex.failed", category: "runtime", spanId: "rt", phase: "end", status: "timeout", error: { type: "timeout", message: "Codex timed out after 3000 ms" }, source: { component: "AgentRunner", observed: true } }),
      ev({ type: "run.timed_out", category: "control", spanId: "rto", parentSpanId: "svc", status: "timeout" }),
      ev({ type: "agent_service.run.failed", category: "control", spanId: "svc", phase: "end", status: "timeout" }),
      ev({ type: "http.request.completed", category: "control", spanId: "root", phase: "end", status: "ok" })];
    const { summary } = buildTrace(events, { capturePolicy: "metadata_only" });
    expect(summary.status).toBe("timeout");
    expect(summary.failure).toMatchObject({ kind: "timeout", spanId: "rt", component: "AgentRunner", path: ["root", "svc", "rt"] });
    expect(summary.failure!.diagnosis).toMatch(/^Run timeout in AgentRunner after 0\.\d+ s\. First actionable timeout: runtime\.codex\.failed/);
    expect(summary.firstFailingStep).toBe("runtime.codex.failed");
  });
  it("handled tool failure keeps parent ok; cancelled never rolls up ok; open spans are incomplete", () => {
    seq = 0;
    const handled = [root(), svcStart(), rtStart(),
      ev({ type: "tool.call.failed", category: "tool", spanId: "t", parentSpanId: "rt", status: "error", error: { type: "exit", message: "exit 1" } }),
      ev({ type: "runtime.codex.completed", category: "runtime", spanId: "rt", phase: "end", status: "ok" }),
      ev({ type: "run.completed", category: "control", spanId: "rd", parentSpanId: "svc", status: "ok" }),
      ev({ type: "agent_service.run.completed", category: "control", spanId: "svc", phase: "end", status: "ok" }),
      ev({ type: "http.request.completed", category: "control", spanId: "root", phase: "end", status: "ok" })];
    const h = buildTrace(handled, { capturePolicy: "metadata_only" });
    expect(h.summary.status).toBe("ok");
    expect(h.summary.failure).toBeUndefined();
    seq = 0;
    const cancelled = [root(), svcStart(), rtStart(), ev({ type: "run.cancelled", category: "control", spanId: "rc", parentSpanId: "svc", status: "cancelled", attributes: { reason: "server_restart" } })];
    const c = buildTrace(cancelled, { capturePolicy: "metadata_only" });
    expect(c.summary.status).toBe("cancelled");
    expect(c.summary.incompleteSpans).toBe(3);
    expect(c.summary.failure?.kind).toBe("cancelled");
    expect(flattenSpans(c.spans).every((s) => s.spanId === "rc" || s.incomplete)).toBe(true);
  });
  it("no model/tool events => capabilities unavailable; degraded flag surfaces", () => {
    seq = 0;
    const events = [root(), svcStart(), rtStart(),
      ev({ type: "capability.unavailable", category: "runtime", spanId: "cap", parentSpanId: "rt", attributes: { model: false, tool: false } }),
      ev({ type: "runtime.codex.completed", category: "runtime", spanId: "rt", phase: "end", status: "ok" }),
      ev({ type: "run.completed", category: "control", spanId: "rd", parentSpanId: "svc", status: "ok" })];
    const v = buildTrace(events, { capturePolicy: "metadata_only", degraded: true });
    expect(v.summary.capabilities).toEqual({ model: "unavailable", tool: "unavailable" });
    expect(v.summary.degraded).toBe(true);
    expect(v.summary.status).toBe("ok");
  });
  it("empty input yields an honest empty view", () => {
    const v = buildTrace([], { capturePolicy: "metadata_only" });
    expect(v.summary.status).toBe("unset"); expect(v.spans).toEqual([]); expect(v.summary.eventCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement**

```ts
// apps/server/src/glassbox/query.ts
import { SCHEMA_VERSION, type CapturePolicy, type Category, type ObservationEvent, type TraceStatus } from "./schema.js";

export interface Span {
  spanId: string; parentSpanId?: string | undefined; name: string; category: Category; status: TraceStatus;
  startedAt: string; endedAt?: string | undefined; durationMs?: number | undefined; incomplete: boolean; sequence: number;
  source: ObservationEvent["source"]; attributes: ObservationEvent["attributes"]; summary?: ObservationEvent["summary"];
  error?: ObservationEvent["error"]; events: ObservationEvent[]; children: Span[]; depth: number;
}
export interface FailureFocus {
  kind: "error" | "timeout" | "cancelled" | "degraded"; spanId: string; eventId: string; sequence: number;
  name: string; category: Category; component: string; message?: string | undefined; path: string[]; diagnosis: string;
}
export interface TraceSummary {
  schemaVersion: typeof SCHEMA_VERSION; capturePolicy: CapturePolicy; runId: string; traceId: string; agentId: string;
  sessionId?: string | undefined; status: TraceStatus; startedAt?: string | undefined; endedAt?: string | undefined;
  durationMs?: number | undefined; eventCount: number; spanCount: number; incompleteSpans: number; redactedEvents: number;
  degraded: boolean; truncated: boolean;
  usage?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number } | undefined;
  capabilities: { model: "observed" | "unavailable"; tool: "observed" | "unavailable" };
  firstFailingStep?: string | undefined; failure?: FailureFocus | undefined;
}
export interface TraceView { summary: TraceSummary; spans: Span[]; events: ObservationEvent[] }

const TERMINAL: Record<string, TraceStatus> = { "run.completed": "ok", "run.failed": "error", "run.cancelled": "cancelled", "run.timed_out": "timeout" };
const CATEGORY_RANK: Record<Category, number> = { tool: 0, model: 1, runtime: 2, workspace: 3, sandbox: 4, policy: 5, infrastructure: 6, control: 7, experience: 8 };

export function flattenSpans(spans: Span[]): Span[] {
  const out: Span[] = []; const walk = (s: Span) => { out.push(s); s.children.forEach(walk); }; spans.forEach(walk); return out;
}

function reconstructSpans(events: ObservationEvent[]): Map<string, Span> {
  const spans = new Map<string, Span>();
  for (const e of events) {
    let span = spans.get(e.spanId);
    if (!span) {
      span = { spanId: e.spanId, parentSpanId: e.parentSpanId, name: e.name, category: e.category, status: e.phase === "start" ? "running" : e.status,
        startedAt: e.timestamp, incomplete: e.phase === "start", sequence: e.sequence, source: e.source, attributes: { ...e.attributes },
        summary: e.summary, error: e.error, events: [], children: [], depth: 0 };
      if (e.phase === "instant") { span.endedAt = e.timestamp; span.durationMs = e.durationMs ?? 0; }
      spans.set(e.spanId, span);
    } else if (e.phase === "end") {
      span.endedAt = e.timestamp; span.status = e.status; span.incomplete = false; span.name = span.name === span.spanId ? e.name : span.name;
      span.durationMs = e.durationMs ?? Math.max(0, Date.parse(e.timestamp) - Date.parse(span.startedAt));
      Object.assign(span.attributes, e.attributes); if (e.error) span.error = e.error; if (e.summary) span.summary = e.summary;
    } else {
      span.events.push(e);
    }
    if (e.spanId !== span.spanId) span.events.push(e);
  }
  return spans;
}

function buildTree(spans: Map<string, Span>): Span[] {
  const roots: Span[] = [];
  for (const s of spans.values()) { const p = s.parentSpanId ? spans.get(s.parentSpanId) : undefined; if (p) p.children.push(s); else roots.push(s); }
  const sortRec = (list: Span[], depth: number) => { list.sort((a, b) => a.sequence - b.sequence); for (const s of list) { s.depth = depth; sortRec(s.children, depth + 1); } };
  sortRec(roots, 0);
  return roots;
}

function pathTo(spans: Map<string, Span>, spanId: string): string[] {
  const path: string[] = []; let cur = spans.get(spanId);
  while (cur) { path.unshift(cur.spanId); cur = cur.parentSpanId ? spans.get(cur.parentSpanId) : undefined; }
  return path;
}

function focusFailure(events: ObservationEvent[], spans: Map<string, Span>, status: TraceStatus, degraded: boolean, durationMs: number | undefined): FailureFocus | undefined {
  if (status === "ok" && !degraded) return undefined;
  const candidates = events.filter((e) => e.status === "error" || e.status === "timeout" || e.status === "cancelled" || e.type === "error.recorded");
  if (candidates.length === 0) {
    if (degraded) return { kind: "degraded", spanId: "", eventId: "", sequence: -1, name: "telemetry.degraded", category: "control", component: "GlassBox", path: [], diagnosis: "Trace evidence is incomplete: the trace store was unavailable during this Run. The Run's real result is unaffected; some spans may be missing." };
    return undefined;
  }
  candidates.sort((a, b) => a.sequence - b.sequence || CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category]);
  const first = candidates[0]!;
  const kind: FailureFocus["kind"] = first.status === "timeout" ? "timeout" : first.status === "cancelled" ? "cancelled" : "error";
  const path = pathTo(spans, first.spanId);
  const secs = durationMs === undefined ? "an unknown duration" : (durationMs / 1000).toFixed(1) + " s";
  const cleanup = events.find((e) => e.type === "runtime.container.stopped" || (e.type === "runtime.codex.failed" && e.attributes.terminationSignal));
  const capability = events.find((e) => e.type === "capability.unavailable");
  const diagnosis = [
    `Run ${status} in ${first.source.component} after ${secs}.`,
    `First actionable ${kind}: ${first.name}${first.error ? " — " + first.error.message : ""}.`,
    cleanup ? `Cleanup evidence: ${cleanup.name}${cleanup.attributes.exitCode !== undefined ? " (exit " + String(cleanup.attributes.exitCode) + ")" : ""}${cleanup.attributes.terminationSignal ? " via " + String(cleanup.attributes.terminationSignal) : ""}.` : "",
    capability ? "No model/tool-level details were available from the runtime." : "",
    degraded ? "Trace store was degraded during this Run; evidence may be incomplete." : "",
  ].filter(Boolean).join(" ");
  return { kind, spanId: first.spanId, eventId: first.eventId, sequence: first.sequence, name: first.name, category: first.category,
    component: first.source.component, message: first.error?.message, path, diagnosis };
}

export function buildTrace(input: ObservationEvent[], opts: { capturePolicy: CapturePolicy; degraded?: boolean | undefined; truncated?: boolean | undefined }): TraceView {
  const events = [...input].sort((a, b) => a.sequence - b.sequence || a.timestamp.localeCompare(b.timestamp));
  const spans = reconstructSpans(events);
  const tree = buildTree(spans);
  const flat = flattenSpans(tree);
  const first = events[0];
  const terminal = [...events].reverse().find((e) => TERMINAL[e.type] !== undefined);
  const status: TraceStatus = terminal ? TERMINAL[terminal.type]! : events.length > 0 ? "running" : "unset";
  const startedAt = first?.timestamp;
  const endedAt = terminal?.timestamp ?? (status === "running" ? undefined : events.at(-1)?.timestamp);
  const durationMs = startedAt && endedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : undefined;
  const usageEvents = events.filter((e) => e.type === "model.completed");
  const sum = (k: string) => usageEvents.reduce((n, e) => n + (typeof e.attributes[k] === "number" ? (e.attributes[k] as number) : 0), 0);
  const usage = usageEvents.length ? { ...(sum("inputTokens") ? { inputTokens: sum("inputTokens") } : {}), ...(sum("cachedInputTokens") ? { cachedInputTokens: sum("cachedInputTokens") } : {}), ...(sum("outputTokens") ? { outputTokens: sum("outputTokens") } : {}) } : undefined;
  const degraded = opts.degraded === true || events.some((e) => e.type === "telemetry.degraded");
  const truncated = opts.truncated === true || events.some((e) => e.type === "trace.truncated");
  const failure = focusFailure(events, spans, status, degraded, durationMs);
  const summary: TraceSummary = {
    schemaVersion: SCHEMA_VERSION, capturePolicy: opts.capturePolicy,
    runId: first?.runId ?? "", traceId: first?.traceId ?? "", agentId: first?.agentId ?? "",
    sessionId: events.find((e) => e.sessionId)?.sessionId,
    status, startedAt, endedAt, durationMs, eventCount: events.length, spanCount: flat.length,
    incompleteSpans: flat.filter((s) => s.incomplete).length, redactedEvents: events.filter((e) => e.privacy.redacted).length,
    degraded, truncated, usage,
    capabilities: { model: events.some((e) => e.category === "model") ? "observed" : "unavailable", tool: events.some((e) => e.category === "tool") ? "observed" : "unavailable" },
    firstFailingStep: failure?.name, failure,
  };
  return { summary, spans: tree, events };
}
```

- [ ] **Step 4: Run → PASS. Typecheck. Commit**

```bash
git add apps/server/src/glassbox/query.ts apps/server/src/glassbox/query.test.ts
git commit -m "feat(glassbox): trace reconstruction, rollup, failure focus and diagnosis

Refs #27"
```

---

### Task 6: ObservationEmitter (#23)

**Files:**
- Create: `apps/server/src/glassbox/emitter.ts`
- Test: `apps/server/src/glassbox/emitter.test.ts`

**Interfaces:**
- Consumes: `eventInputSchema`, `observationEventSchema`, `newId`, `SCHEMA_VERSION`, `REDACTION_RULESET_VERSION`, `EventInput`, `ObservationEvent`, `CapturePolicy` (T1); `redactEvent`, `failClosed` (T3); `TraceStore` (T4).
- Produces:
```ts
export interface EmitterOptions { store: TraceStore; capturePolicy: CapturePolicy; extraPatterns?: RegExp[] | undefined; log?: ((message: string, meta: Record<string, unknown>) => void) | undefined }
export interface SpanHandle { spanId: string; end(status: TraceStatus, extra?: { type?: EventType; attributes?: EventInput["attributes"]; error?: EventInput["error"]; summary?: EventInput["summary"]; name?: string }): ObservationEvent | null }
export class ObservationEmitter {
  constructor(options: EmitterOptions)
  readonly capturePolicy: CapturePolicy
  emit(input: EventInput): ObservationEvent | null                 // sync; null if quarantined
  startSpan(input: Omit<EventInput, "phase" | "status">): SpanHandle
  flush(): Promise<void>                                            // await queued appends (tests)
  isDegraded(runId: string): boolean
  seedSequence(traceId: string, lastSequence: number): void
}
export function createDefaultEmitter(): ObservationEmitter          // MemoryTraceStore + metadata_only, for tests/defaults
```

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/src/glassbox/emitter.test.ts
import { describe, expect, it } from "vitest";
import { ObservationEmitter, createDefaultEmitter } from "./emitter.js";
import { MemoryTraceStore, type TraceStore } from "./store.js";
import type { ObservationEvent } from "./schema.js";

const base = { traceId: "trc_1", spanId: "spn_1", runId: "run-1", agentId: "agt-1", type: "run.created" as const, category: "control" as const, name: "run.created", source: { component: "AgentService", observed: true } };

describe("ObservationEmitter", () => {
  it("fills ids, timestamps and monotonic sequence; redacts; stores", async () => {
    const store = new MemoryTraceStore(); const em = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const a = em.emit({ ...base, attributes: { token: "x", note: "Bearer abcdefghijklmnopqrstuvwxyz" } })!;
    const b = em.emit({ ...base, spanId: "spn_2" })!;
    expect(a.eventId.startsWith("evt_")).toBe(true); expect(a.sequence).toBe(0); expect(b.sequence).toBe(1);
    expect(a.attributes).toEqual({ note: "[REDACTED:bearer]" }); expect(a.privacy.redacted).toBe(true);
    await em.flush();
    expect((await store.readRun("run-1")).map((e) => e.sequence)).toEqual([0, 1]);
  });
  it("returns synchronously even if the store hangs, and never throws when the store rejects", async () => {
    let calls = 0;
    const slow: TraceStore = { async initialize() {}, async append() { calls++; await new Promise((r) => setTimeout(r, 200)); return { stored: true }; }, async readRun() { return []; }, runIdForTrace() { return undefined; }, listRuns() { return []; }, markTruncated() {} };
    const em = new ObservationEmitter({ store: slow, capturePolicy: "metadata_only" });
    const t = performance.now(); em.emit(base); expect(performance.now() - t).toBeLessThan(50);
    const bad: TraceStore = { ...slow, async append() { throw new Error("EACCES"); } };
    const logs: string[] = [];
    const em2 = new ObservationEmitter({ store: bad, capturePolicy: "metadata_only", log: (m) => logs.push(m) });
    expect(() => em2.emit(base)).not.toThrow();
    await em2.flush();
    expect(em2.isDegraded("run-1")).toBe(true);
    expect(logs.some((l) => l.includes("telemetry.degraded"))).toBe(true);
    expect(calls).toBeGreaterThan(0);
  });
  it("quarantines malformed input as error.recorded", async () => {
    const store = new MemoryTraceStore(); const em = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const out = em.emit({ ...base, status: "done" as never });
    expect(out).toBeNull();
    await em.flush();
    const stored = await store.readRun("run-1");
    expect(stored).toHaveLength(1); expect(stored[0]!.type).toBe("error.recorded"); expect(stored[0]!.attributes.quarantinedType).toBe("run.created");
  });
  it("spans: start/end share spanId, end computes durationMs", async () => {
    const store = new MemoryTraceStore(); const em = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const span = em.startSpan({ ...base, type: "agent_service.run.started", name: "service" });
    await new Promise((r) => setTimeout(r, 15));
    const end = span.end("ok", { type: "agent_service.run.completed" })!;
    expect(end.spanId).toBe(span.spanId); expect(end.phase).toBe("end"); expect(end.durationMs).toBeGreaterThanOrEqual(10);
    await em.flush();
    const [s, e] = await store.readRun("run-1"); expect(s!.phase).toBe("start"); expect(s!.status).toBe("running"); expect(e!.status).toBe("ok");
  });
  it("emits trace.truncated once when the store caps and marks the run", async () => {
    const store = new MemoryTraceStore(); const em = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    for (let i = 0; i < 1002; i++) em.emit({ ...base, spanId: "s" + i, type: "tool.call.completed", category: "tool", name: "t" });
    await em.flush();
    const events: ObservationEvent[] = await store.readRun("run-1");
    expect(events.filter((e) => e.type === "trace.truncated")).toHaveLength(1);
    expect(store.listRuns()[0]!.truncated).toBe(true);
  });
  it("seedSequence continues after a rebuild", () => {
    const em = createDefaultEmitter(); em.seedSequence("trc_1", 41);
    expect(em.emit(base)!.sequence).toBe(42);
  });
});
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement**

```ts
// apps/server/src/glassbox/emitter.ts
import { failClosed, redactEvent } from "./redact.js";
import {
  REDACTION_RULESET_VERSION, SCHEMA_VERSION, eventInputSchema, newId, observationEventSchema,
  type CapturePolicy, type EventInput, type EventType, type ObservationEvent, type TraceStatus,
} from "./schema.js";
import { MemoryTraceStore, type TraceStore } from "./store.js";

export interface EmitterOptions {
  store: TraceStore; capturePolicy: CapturePolicy; extraPatterns?: RegExp[] | undefined;
  log?: ((message: string, meta: Record<string, unknown>) => void) | undefined;
}
export interface SpanHandle {
  spanId: string;
  end(status: TraceStatus, extra?: { type?: EventType; attributes?: EventInput["attributes"]; error?: EventInput["error"]; summary?: EventInput["summary"]; name?: string }): ObservationEvent | null;
}

export class ObservationEmitter {
  readonly capturePolicy: CapturePolicy;
  private readonly store: TraceStore;
  private readonly extraPatterns: RegExp[];
  private readonly log: (message: string, meta: Record<string, unknown>) => void;
  private readonly sequences = new Map<string, number>();
  private readonly degradedRuns = new Set<string>();
  private readonly truncatedRuns = new Set<string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(options: EmitterOptions) {
    this.store = options.store; this.capturePolicy = options.capturePolicy;
    this.extraPatterns = options.extraPatterns ?? []; this.log = options.log ?? (() => undefined);
  }

  seedSequence(traceId: string, lastSequence: number): void {
    this.sequences.set(traceId, Math.max(this.sequences.get(traceId) ?? -1, lastSequence));
  }
  isDegraded(runId: string): boolean { return this.degradedRuns.has(runId); }
  flush(): Promise<void> { return this.queue; }

  emit(input: EventInput): ObservationEvent | null {
    const parsed = eventInputSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      this.quarantine(input, issue ? issue.path.join(".") + ": " + issue.message : "invalid");
      return null;
    }
    const event = this.build(parsed.data);
    let safe: ObservationEvent;
    try { safe = redactEvent(event, { policy: this.capturePolicy, extraPatterns: this.extraPatterns }); }
    catch (error) { safe = failClosed(event); this.log("redaction_failed_closed", { runId: event.runId, error: String(error) }); }
    const final = observationEventSchema.safeParse(safe);
    if (!final.success) { this.quarantine(input, "post-redaction: " + final.error.issues[0]?.message); return null; }
    this.enqueue(final.data);
    return final.data;
  }

  startSpan(input: Omit<EventInput, "phase" | "status">): SpanHandle {
    const spanId = input.spanId ?? newId("spn");
    const startedAt = Date.now();
    this.emit({ ...input, spanId, phase: "start", status: "running" });
    return {
      spanId,
      end: (status, extra = {}) => this.emit({
        ...input, spanId, phase: "end", status,
        type: extra.type ?? input.type, name: extra.name ?? input.name,
        durationMs: Date.now() - startedAt,
        attributes: { ...(input.attributes ?? {}), ...(extra.attributes ?? {}) },
        ...(extra.error ? { error: extra.error } : {}), ...(extra.summary ? { summary: extra.summary } : {}),
      }),
    };
  }

  private build(data: ReturnType<typeof eventInputSchema.parse>): ObservationEvent {
    const next = (this.sequences.get(data.traceId) ?? -1) + 1;
    this.sequences.set(data.traceId, next);
    return observationEventSchema.parse({
      ...data, schemaVersion: SCHEMA_VERSION, eventId: newId("evt"), sequence: next,
      timestamp: data.timestamp ?? new Date().toISOString(),
      privacy: { redacted: false, rulesetVersion: REDACTION_RULESET_VERSION },
    });
  }

  private quarantine(input: EventInput, reason: string): void {
    const ids = { traceId: String((input as { traceId?: unknown }).traceId ?? "unknown"), runId: String((input as { runId?: unknown }).runId ?? "unknown"), agentId: String((input as { agentId?: unknown }).agentId ?? "unknown") };
    if (ids.traceId === "unknown" || ids.runId === "unknown") { this.log("quarantine_dropped", { reason }); return; }
    const fallback = eventInputSchema.safeParse({
      ...ids, spanId: newId("spn"), type: "error.recorded", category: "control", name: "error.recorded", status: "error",
      source: { component: "GlassBox", observed: true },
      attributes: { quarantinedType: String((input as { type?: unknown }).type ?? "unknown"), reason: reason.slice(0, 200) },
    });
    if (fallback.success) this.enqueue(this.build(fallback.data));
  }

  private enqueue(event: ObservationEvent): void {
    this.queue = this.queue.then(async () => {
      try {
        const result = await this.store.append(event);
        if (!result.stored && (result.reason === "cap_events" || result.reason === "cap_bytes") && !this.truncatedRuns.has(event.runId)) {
          this.truncatedRuns.add(event.runId); this.store.markTruncated(event.runId);
          const t = eventInputSchema.parse({ traceId: event.traceId, runId: event.runId, agentId: event.agentId, spanId: newId("spn"), type: "trace.truncated", category: "control", name: "trace.truncated", status: "unset", source: { component: "GlassBox", observed: true }, attributes: { reason: result.reason } });
          await this.store.append(this.build(t));
        }
      } catch (error) {
        if (!this.degradedRuns.has(event.runId)) {
          this.degradedRuns.add(event.runId);
          this.log("telemetry.degraded", { runId: event.runId, traceId: event.traceId, error: String(error).slice(0, 200) });
        }
      }
    });
  }
}

export function createDefaultEmitter(): ObservationEmitter {
  return new ObservationEmitter({ store: new MemoryTraceStore(), capturePolicy: "metadata_only" });
}
```

- [ ] **Step 4: Run → PASS. Typecheck. Run `glassbox-privacy-reviewer` on `glassbox/`. Commit**

```bash
git add apps/server/src/glassbox/emitter.ts apps/server/src/glassbox/emitter.test.ts
git commit -m "feat(glassbox): non-blocking ObservationEmitter with spans, quarantine, caps and degraded mode

Closes #23"
```

---

### Task 7: Wiring + Fastify ingress + AgentService adapter (#25, #26)

**Files:**
- Modify: `apps/server/src/config.ts` (env schema + return object)
- Modify: `apps/server/src/types.ts:33-43` (`AgentRun`), `:71-76` (`RunnerRequest`)
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/src/app.ts:26-63` (createApp signature + hooks), `:119-124` (messages route)
- Modify: `apps/server/src/agent-service.ts` (constructor, `initialize`, `sendMessage`, `executeRun`, `cancelExecution`)
- Modify: `apps/server/src/runner-factory.ts`
- Modify: `.env.example`, `README.md` config table
- Test: `apps/server/src/agent-service.test.ts` (append), `apps/server/src/app.test.ts` (append)

**Interfaces:**
- Consumes: `ObservationEmitter`, `createDefaultEmitter`, `SpanHandle` (T6); `NdjsonTraceStore`, `TraceStore` (T4); `createTraceContext`, `TraceContext` (T1).
- Produces:
  - `AppConfig.glassboxCapturePolicy: "metadata_only" | "safe_summary"`, `AppConfig.glassboxDemoFailure: "off" | "timeout"`, `AppConfig.traceDirectory: string`
  - `AgentRun.traceId?: string | undefined`
  - `RunnerRequest.trace?: { traceId: string; runId: string; agentId: string; parentSpanId: string } | undefined`, `RunnerRequest.timeoutMs?: number | undefined`
  - `new AgentService(config, store, workspaces, runner, emitter = createDefaultEmitter())`
  - `service.sendMessage(agentId, prompt, context?: TraceContext)` — sets `context.runId`/`context.agentId` and emits the root http span (start) + `run.created`
  - `createRunner(config, emitter)`; runners' constructors accept `(config, emitter = createDefaultEmitter())` (implemented in T8; T7 adds the parameter and stores it unused)
  - `createApp(config, service, glassbox?: { emitter: ObservationEmitter; store: TraceStore })`; `request.glassbox?: TraceContext` decorated on message POSTs

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/src/agent-service.test.ts` (reuse `makeService`; add an emitter param):

```ts
import { ObservationEmitter } from "./glassbox/emitter.js";
import { MemoryTraceStore } from "./glassbox/store.js";
import { createTraceContext } from "./glassbox/context.js";

class TimeoutRunner extends FakeRunner {
  override async run(): Promise<RunnerResult> { throw new Error("Codex timed out after 3000 ms"); }
}
async function makeTraced(runner: AgentRunner = new FakeRunner()) {
  const store = new MemoryTraceStore(); const emitter = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-")); temporaryDirectories.push(root);
  const config = loadConfig({ NODE_ENV: "test", APP_DATA_DIR: path.join(root, "data"), AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"), CODEX_HOME: path.join(root, "codex"), ARK_API_KEY: "test-key", ARK_MODEL: "ep-test" });
  const service = new AgentService(config, new JsonStore(path.join(root, "data", "db.json")), new WorkspaceManager(path.join(root, "workspaces")), runner, emitter);
  await service.initialize();
  return { service, store, emitter };
}
const settle = async (service: AgentService, runId: string) => { for (let i = 0; i < 50; i++) { const r = service.getRun(runId); if (["completed", "failed", "cancelled"].includes(r.status)) return r; await new Promise((r) => setTimeout(r, 10)); } throw new Error("run did not settle"); };

describe("GlassBox control-plane adapter", () => {
  it("links the Run to a trace and emits root, control and terminal events in order", async () => {
    const { service, store, emitter } = await makeTraced();
    const agent = await service.createAgent({ name: "traced" });
    const ctx = createTraceContext({ requestId: "req-1", method: "POST", path: "/api/agents/x/messages" }, "metadata_only");
    const { run } = await service.sendMessage(agent.id, "hello", ctx);
    expect(ctx.runId).toBe(run.id); expect(service.getRun(run.id).traceId).toBe(ctx.traceId);
    await settle(service, run.id); await emitter.flush();
    const types = (await store.readRun(run.id)).map((e) => e.type);
    expect(types).toEqual(["http.request.received", "run.created", "agent_service.run.started", "run.started", "run.completed", "agent_service.run.completed"]);
    const events = await store.readRun(run.id);
    expect(events[1]!.parentSpanId).toBe(ctx.rootSpanId);
    expect(events[2]!.parentSpanId).toBe(ctx.rootSpanId);
    expect(events.every((e) => e.traceId === ctx.traceId && e.requestId === "req-1")).toBe(true);
    expect(events.find((e) => e.type === "run.completed")!.attributes).toMatchObject({ inputTokens: 12, outputTokens: 5 });
    expect(JSON.stringify(events)).not.toContain("hello"); // prompt text is never stored
  });
  it("classifies a runner timeout as timeout, and stop as cancelled with actor evidence", async () => {
    const { service, store, emitter } = await makeTraced(new TimeoutRunner());
    const agent = await service.createAgent({ name: "t" });
    const { run } = await service.sendMessage(agent.id, "x");
    await settle(service, run.id); await emitter.flush();
    const events = await store.readRun(run.id);
    expect(events.map((e) => e.type)).toContain("run.timed_out");
    expect(events.at(-1)).toMatchObject({ type: "agent_service.run.failed", status: "timeout" });
  });
  it("restart marks interrupted Runs cancelled in the trace", async () => {
    const { service, store, emitter } = await makeTraced(new (class extends FakeRunner { override run(): Promise<RunnerResult> { return new Promise(() => undefined); } })());
    const agent = await service.createAgent({ name: "r" });
    const { run } = await service.sendMessage(agent.id, "x");
    await new Promise((r) => setTimeout(r, 20)); await emitter.flush();
    // a second service on the same store simulates a process restart
    const restarted = new AgentService((service as unknown as { config: never }).config, (service as unknown as { store: never }).store, (service as unknown as { workspaces: never }).workspaces, new FakeRunner(), emitter);
    await restarted.initialize(); await emitter.flush();
    const events = await store.readRun(run.id);
    expect(events.at(-1)).toMatchObject({ type: "run.cancelled", status: "cancelled", attributes: { reason: "server_restart" } });
  });
});
```

Append to `apps/server/src/app.test.ts`:

```ts
import { ObservationEmitter } from "./glassbox/emitter.js";
import { MemoryTraceStore } from "./glassbox/store.js";

it("ends the root http span with the response status", async () => {
  const store = new MemoryTraceStore(); const emitter = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
  const calls: unknown[] = [];
  const svc = { ...service, sendMessage: async (id: string, _c: string, ctx?: { runId?: string; agentId?: string; traceId: string; rootSpanId: string; requestId?: string }) => {
    calls.push(ctx); if (ctx) { ctx.runId = "run-1"; ctx.agentId = id; emitter.emit({ traceId: ctx.traceId, spanId: ctx.rootSpanId, runId: "run-1", agentId: id, type: "http.request.received", category: "control", name: "POST /api/agents/:id/messages", phase: "start", status: "running", source: { component: "Fastify", observed: true }, requestId: ctx.requestId }); }
    return { run: { id: "run-1" }, message: {} }; } } as unknown as AgentService;
  const app = await createApp(loadConfig({ NODE_ENV: "test" }), svc, { emitter, store });
  const res = await app.inject({ method: "POST", url: "/api/agents/2c1b9f8e-3b7e-4b9d-9d3a-1c2d3e4f5a6b/messages", payload: { content: "hi" } });
  expect(res.statusCode).toBe(202); expect(calls[0]).toBeTruthy();
  await emitter.flush();
  const events = await store.readRun("run-1");
  expect(events.map((e) => e.type)).toEqual(["http.request.received", "http.request.completed"]);
  expect(events[1]).toMatchObject({ phase: "end", status: "ok", attributes: { statusCode: 202, method: "POST" } });
  expect(JSON.stringify(events)).not.toContain("authorization");
  await app.close();
});
```

- [ ] **Step 2: Run → FAIL (constructor arity / missing module / `traceId` undefined)**

Run: `npm run test -w @launchpad/server -- src/agent-service.test.ts src/app.test.ts`

- [ ] **Step 3: config.ts**

Add to `envSchema` (after `NODE_ENV`):
```ts
  GLASSBOX_CAPTURE_POLICY: z.enum(["metadata_only", "safe_summary"]).default("metadata_only"),
  GLASSBOX_DEMO_FAILURE: z.enum(["off", "timeout"]).default("off"),
  GLASSBOX_TRACE_DIR: z.string().optional(),
```
Add to the returned object (after `nodeEnv`):
```ts
    glassboxCapturePolicy: env.GLASSBOX_CAPTURE_POLICY,
    glassboxDemoFailure: env.GLASSBOX_DEMO_FAILURE,
    traceDirectory: path.resolve(env.GLASSBOX_TRACE_DIR ?? path.join(env.APP_DATA_DIR, "traces")),
```

- [ ] **Step 4: types.ts**

```ts
export interface AgentRun {
  // …existing fields…
  traceId?: string | undefined;
}

export interface RunnerTraceContext { traceId: string; runId: string; agentId: string; parentSpanId: string }

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  trace?: RunnerTraceContext | undefined;
  timeoutMs?: number | undefined;
}
```

- [ ] **Step 5: runner-factory.ts and runner constructors (parameter only)**

```ts
// runner-factory.ts
import type { ObservationEmitter } from "./glassbox/emitter.js";
export function createRunner(config: AppConfig, emitter: ObservationEmitter): AgentRunner {
  return config.runtimeProvider === "container" ? new ContainerCodexRunner(config, emitter) : new CodexRunner(config, emitter);
}
```
In both runners replace `constructor(private readonly config: AppConfig) {}` with:
```ts
  constructor(private readonly config: AppConfig, protected readonly emitter: ObservationEmitter = createDefaultEmitter()) {}
```
and import `{ ObservationEmitter, createDefaultEmitter } from "./glassbox/emitter.js"`. (T8 uses `this.emitter`.)

- [ ] **Step 6: agent-service.ts**

Imports:
```ts
import { createTraceContext, type TraceContext } from "./glassbox/context.js";
import { createDefaultEmitter, type ObservationEmitter, type SpanHandle } from "./glassbox/emitter.js";
```
Constructor — add a fifth parameter and a private map:
```ts
  private readonly spans = new Map<string, { traceId: string; rootSpanId: string; requestId?: string | undefined; service?: SpanHandle | undefined; cancelRequestedAt?: string | undefined }>();
  constructor(
    private readonly config: AppConfig, private readonly store: JsonStore, private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner, private readonly emitter: ObservationEmitter = createDefaultEmitter(),
  ) {}
```
`initialize()` — after the existing `store.mutate(...)`, emit for interrupted runs (collect them inside the mutate callback into a local array `interrupted: AgentRun[]` by pushing `structuredClone(run)` before mutating):
```ts
    for (const run of interrupted) {
      if (!run.traceId) continue;
      this.emitter.emit({ traceId: run.traceId, spanId: newId("spn"), runId: run.id, agentId: run.agentId, type: "run.cancelled", category: "control",
        name: "run.cancelled", status: "cancelled", source: { component: "AgentService", observed: true }, attributes: { reason: "server_restart" } });
    }
```
(import `newId` from `./glassbox/schema.js`.)

`sendMessage(agentId, prompt, context?: TraceContext)` — after `const runId = randomUUID();` build the context and emit, and store `traceId` on the run:
```ts
    const ctx = context ?? createTraceContext({}, this.emitter.capturePolicy);
    ctx.runId = runId; ctx.agentId = agentId;
    const ids = { traceId: ctx.traceId, runId, agentId, requestId: ctx.requestId, actorId: ctx.actorId, actorType: ctx.actorType };
    if (context) {
      this.emitter.emit({ ...ids, spanId: ctx.rootSpanId, type: "http.request.received", category: "control", phase: "start", status: "running",
        name: (ctx.method ?? "POST") + " /api/agents/:id/messages", timestamp: ctx.receivedAt, source: { component: "Fastify", observed: true } });
    }
    this.emitter.emit({ ...ids, spanId: newId("spn"), parentSpanId: context ? ctx.rootSpanId : undefined, type: "run.created", category: "control",
      name: "run.created", status: "ok", source: { component: "AgentService", observed: true }, attributes: { promptBytes: Buffer.byteLength(prompt, "utf8") } });
    this.spans.set(runId, { traceId: ctx.traceId, rootSpanId: ctx.rootSpanId, requestId: ctx.requestId });
```
Set `traceId: ctx.traceId` on the `run` object literal (it is created *after* `runId`, so reorder: build `ctx`/emit first, then `const run: AgentRun = { …, traceId: ctx.traceId }`). Note `parentSpanId: undefined` is fine under `exactOptionalPropertyTypes` only if the field is declared `?: string | undefined` — `eventInputSchema` accepts `undefined` via `.optional()`, and the `EventInput` type is `z.input`, so spread `...(context ? { parentSpanId: ctx.rootSpanId } : {})` instead to be safe.

`executeRun` — wrap the runner call:
```ts
    const link = this.spans.get(run.id);
    const ids = link ? { traceId: link.traceId, runId: run.id, agentId: agentAtStart.id, requestId: link.requestId } : undefined;
    const service = ids ? this.emitter.startSpan({ ...ids, parentSpanId: link!.rootSpanId, type: "agent_service.run.started", category: "control",
      name: "agent_service.run", source: { component: "AgentService", observed: true }, attributes: { resume: agentAtStart.codexThreadId !== null } }) : undefined;
    if (link) link.service = service;
    if (ids) this.emitter.emit({ ...ids, spanId: newId("spn"), parentSpanId: service!.spanId, type: "run.started", category: "control", name: "run.started", status: "ok", source: { component: "AgentService", observed: true } });
    // …existing `await this.store.mutate` marking running…
    try {
      // …existing cancellation check…
      const result = await this.runner.run({
        agentId: agentAtStart.id, workspacePath: agentAtStart.workspacePath, prompt: run.prompt, threadId: agentAtStart.codexThreadId,
        ...(ids && service ? { trace: { traceId: ids.traceId, runId: run.id, agentId: agentAtStart.id, parentSpanId: service.spanId } } : {}),
        ...(this.config.glassboxDemoFailure === "timeout" ? { timeoutMs: 3_000 } : {}),
      });
      // …existing success mutate…
      if (ids && service) {
        this.emitter.emit({ ...ids, spanId: newId("spn"), parentSpanId: service.spanId, type: "run.completed", category: "control", name: "run.completed", status: "ok",
          source: { component: "AgentService", observed: true }, attributes: { outputBytes: Buffer.byteLength(result.output, "utf8"), ...(result.usage ?? {}) }, ...(result.threadId ? { sessionId: result.threadId } : {}) });
        service.end("ok", { type: "agent_service.run.completed" });
      }
    } catch (error) {
      // …existing failure mutate (cancelled/failed)…
      if (ids && service) {
        const message = error instanceof Error ? error.message : String(error);
        const status: TraceStatus = cancelled ? "cancelled" : /timed out/i.test(message) ? "timeout" : "error";
        const type = status === "cancelled" ? "run.cancelled" : status === "timeout" ? "run.timed_out" : "run.failed";
        this.emitter.emit({ ...ids, spanId: newId("spn"), parentSpanId: service.spanId, type, category: "control", name: type, status,
          source: { component: "AgentService", observed: true }, error: { type: status, message },
          attributes: { ...(link?.cancelRequestedAt ? { cancelRequestedAt: link.cancelRequestedAt, cancelledBy: "local-user" } : {}) } });
        service.end(status, { type: "agent_service.run.failed", error: { type: status, message } });
      }
    } finally { this.spans.delete(run.id); }
```
(import `type TraceStatus` from `./glassbox/schema.js`.) `cancelExecution` — first line: `for (const [runId, link] of this.spans) if (this.store.snapshot().runs.find((r) => r.id === runId)?.agentId === agentId) link.cancelRequestedAt = now();`.

- [ ] **Step 7: app.ts**

Signature and decoration:
```ts
import type { TraceContext } from "./glassbox/context.js";
import { createTraceContext } from "./glassbox/context.js";
import type { ObservationEmitter } from "./glassbox/emitter.js";
import type { TraceStore } from "./glassbox/store.js";
declare module "fastify" { interface FastifyRequest { glassbox?: TraceContext | undefined } }

export async function createApp(config: AppConfig, service: AgentService, glassbox?: { emitter: ObservationEmitter; store: TraceStore }): Promise<FastifyInstance> {
```
After the auth hook:
```ts
  if (glassbox) {
    app.addHook("onRequest", async (request) => {
      if (request.method === "POST" && /^\/api\/agents\/[^/]+\/messages$/.test(request.url)) {
        request.glassbox = createTraceContext({ requestId: request.id, method: request.method, path: "/api/agents/:id/messages" }, glassbox.emitter.capturePolicy);
      }
    });
    app.addHook("onResponse", async (request, reply) => {
      const ctx = request.glassbox;
      if (!ctx?.runId || !ctx.agentId) return;
      glassbox.emitter.emit({ traceId: ctx.traceId, spanId: ctx.rootSpanId, runId: ctx.runId, agentId: ctx.agentId, requestId: ctx.requestId, actorId: ctx.actorId,
        type: "http.request.completed", category: "control", phase: "end", status: reply.statusCode < 400 ? "ok" : "error",
        name: (ctx.method ?? "POST") + " /api/agents/:id/messages", durationMs: Math.max(0, Date.now() - Date.parse(ctx.receivedAt)),
        source: { component: "Fastify", observed: true }, attributes: { statusCode: reply.statusCode, method: ctx.method ?? "POST" } });
    });
  }
```
Messages route: `const result = await service.sendMessage(id, body.content, request.glassbox);`

- [ ] **Step 8: index.ts**

```ts
import { ObservationEmitter } from "./glassbox/emitter.js";
import { NdjsonTraceStore } from "./glassbox/store.js";
// after `const store = new JsonStore(...)`:
const traceStore = new NdjsonTraceStore(config.traceDirectory);
await traceStore.initialize();
const emitter = new ObservationEmitter({ store: traceStore, capturePolicy: config.glassboxCapturePolicy, log: (message, meta) => console.warn("[glassbox]", message, JSON.stringify(meta)) });
for (const entry of traceStore.listRuns()) emitter.seedSequence(entry.traceId, entry.lastSequence);
const runner = createRunner(config, emitter);
const service = new AgentService(config, store, workspaces, runner, emitter);
// …
const app = await createApp(config, service, { emitter, store: traceStore });
```

- [ ] **Step 9: `.env.example` + README**

Append to `.env.example`:
```dotenv
# GlassBox observability. metadata_only stores IDs/timing/status/counts only;
# safe_summary adds bounded, redacted text summaries. Raw capture does not exist.
GLASSBOX_CAPTURE_POLICY=metadata_only
# Demo-only: force a deterministic runtime timeout through the real Run path. Keep off.
GLASSBOX_DEMO_FAILURE=off
# Trace files (one NDJSON per Run). Defaults to $APP_DATA_DIR/traces.
# GLASSBOX_TRACE_DIR=
```
README config table rows:
```markdown
| `GLASSBOX_CAPTURE_POLICY` | `metadata_only` | `metadata_only` or `safe_summary`; raw capture is not implemented. |
| `GLASSBOX_DEMO_FAILURE` | `off` | `timeout` forces a 3 s runtime timeout for the demo's controlled failure. |
| `GLASSBOX_TRACE_DIR` | `$APP_DATA_DIR/traces` | Directory for per-Run NDJSON trace files. |
```

- [ ] **Step 10: Run all server tests, typecheck, commit**

Run: `npm run test -w @launchpad/server -- --testTimeout=30000` → all pass except the known Windows path assertion; `npm run typecheck` clean.
```bash
git add apps/server/src .env.example README.md
git commit -m "feat(glassbox): trace context at ingress, Run-trace link, control-plane events

Closes #25
Closes #26"
```

---

### Task 8: Runner adapters + Codex stream observer (#28)

**Files:**
- Create: `apps/server/src/glassbox/codex-observer.ts`
- Modify: `apps/server/src/codex-runner.ts` (`parseCodexEventLine` sink param, `run()`), `apps/server/src/container-codex-runner.ts` (`run()`)
- Test: `apps/server/src/glassbox/codex-observer.test.ts`

**Interfaces:**
- Consumes: `ObservationEmitter`, `SpanHandle` (T6); `RunnerTraceContext` (T7); fixture files + `docs/CODEX_EVENTS.md` (T2).
- Produces:
```ts
export interface CodexStreamSink { onThreadStarted(threadId: string): void; onItemCompleted(item: Record<string, unknown>): void; onTurnCompleted(usage: Record<string, unknown>): void; onError(message: string): void }
export class CodexStreamObserver implements CodexStreamSink {
  constructor(emitter: ObservationEmitter, trace: RunnerTraceContext, parentSpanId: string, adapter: "CodexRunner" | "ContainerCodexRunner")
  sessionId: string | undefined
  finish(): void   // emits capability.unavailable once if no tool/model events were observed
}
// codex-runner.ts
export function parseCodexEventLine(line: string, parsed: ParsedEvents, sink?: CodexStreamSink): void
```

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/src/glassbox/codex-observer.test.ts
import { describe, expect, it } from "vitest";
import { CodexStreamObserver } from "./codex-observer.js";
import { ObservationEmitter } from "./emitter.js";
import { MemoryTraceStore } from "./store.js";
import { parseCodexEventLine } from "../codex-runner.js";

const trace = { traceId: "trc_1", runId: "run-1", agentId: "agt-1", parentSpanId: "spn_rt" };
const parsed = () => ({ messages: [] as string[], threadId: null as string | null, usage: null as null | object, errors: [] as string[] });
const lines = [
  JSON.stringify({ type: "thread.started", thread_id: "thr-1" }),
  JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "SECRET THOUGHTS" } }),
  JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz' x", exit_code: 0, aggregated_output: "ok" } }),
  JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "npm test", exit_code: 1, aggregated_output: "1 failing" } }),
  JSON.stringify({ type: "item.completed", item: { type: "file_change", changes: [{ path: "src/a.ts", kind: "add" }, { path: "src/b.ts", kind: "update" }] } }),
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Done" } }),
  JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 } }),
];

describe("CodexStreamObserver", () => {
  it("maps observed items to tool/workspace/model events, never stores reasoning, and redacts commands", async () => {
    const store = new MemoryTraceStore(); const em = new ObservationEmitter({ store, capturePolicy: "safe_summary" });
    const obs = new CodexStreamObserver(em, trace, "spn_rt", "CodexRunner"); const p = parsed();
    for (const l of lines) parseCodexEventLine(l, p, obs);
    obs.finish(); await em.flush();
    const events = await store.readRun("run-1");
    expect(obs.sessionId).toBe("thr-1");
    expect(events.map((e) => e.type)).toEqual(["tool.call.completed", "tool.call.failed", "workspace.changed", "model.completed"]);
    expect(events.every((e) => e.parentSpanId === "spn_rt" && e.source.observed)).toBe(true);
    expect(events[0]!.attributes.exitCode).toBe(0); expect(events[0]!.summary?.text).toContain("[REDACTED:bearer]");
    expect(events[1]).toMatchObject({ status: "error", error: { type: "exit_code", message: "exit code 1" } });
    expect(events[2]!.attributes).toMatchObject({ fileCount: 2, added: 1, updated: 1 });
    expect(events[3]!.attributes).toEqual({ inputTokens: 100, cachedInputTokens: 40, outputTokens: 7 });
    expect(JSON.stringify(events)).not.toContain("SECRET THOUGHTS");
    expect(events.some((e) => e.type === "capability.unavailable")).toBe(false);
  });
  it("metadata_only keeps commands out entirely", async () => {
    const store = new MemoryTraceStore(); const em = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const obs = new CodexStreamObserver(em, trace, "spn_rt", "CodexRunner"); parseCodexEventLine(lines[2]!, parsed(), obs); await em.flush();
    const [e] = await store.readRun("run-1");
    expect(e!.summary).toBeUndefined(); expect(JSON.stringify(e)).not.toContain("curl"); expect(e!.attributes.commandBytes).toBeGreaterThan(0);
  });
  it("emits exactly one capability.unavailable when the stream exposes only messages", async () => {
    const store = new MemoryTraceStore(); const em = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
    const obs = new CodexStreamObserver(em, trace, "spn_rt", "ContainerCodexRunner");
    parseCodexEventLine(lines[0]!, parsed(), obs); parseCodexEventLine(lines[5]!, parsed(), obs); obs.finish(); obs.finish(); await em.flush();
    const events = await store.readRun("run-1");
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ type: "capability.unavailable", attributes: { model: false, tool: false } });
  });
});
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement the observer and the sink hook**

```ts
// apps/server/src/glassbox/codex-observer.ts
import type { RunnerTraceContext } from "../types.js";
import type { ObservationEmitter } from "./emitter.js";
import { newId } from "./schema.js";

export interface CodexStreamSink {
  onThreadStarted(threadId: string): void;
  onItemCompleted(item: Record<string, unknown>): void;
  onTurnCompleted(usage: Record<string, unknown>): void;
  onError(message: string): void;
}

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export class CodexStreamObserver implements CodexStreamSink {
  sessionId: string | undefined;
  private sawTool = false; private sawModel = false; private finished = false;
  constructor(private readonly emitter: ObservationEmitter, private readonly trace: RunnerTraceContext, private readonly parentSpanId: string, private readonly adapter: "CodexRunner" | "ContainerCodexRunner") {}

  private base(type: Parameters<ObservationEmitter["emit"]>[0]["type"], name: string) {
    return { traceId: this.trace.traceId, runId: this.trace.runId, agentId: this.trace.agentId, spanId: newId("spn"), parentSpanId: this.parentSpanId,
      type, name, source: { component: "AgentRunner", adapter: this.adapter, observed: true }, ...(this.sessionId ? { sessionId: this.sessionId } : {}) };
  }
  onThreadStarted(threadId: string): void { this.sessionId = threadId; }
  onItemCompleted(item: Record<string, unknown>): void {
    const kind = str(item.type);
    if (kind === "command_execution") {
      this.sawTool = true;
      const command = str(item.command) ?? ""; const exitCode = num(item.exit_code) ?? num(item.exitCode);
      const failed = exitCode !== undefined && exitCode !== 0;
      const first = command.trim().split(/\s+/)[0] ?? "";
      this.emitter.emit({ ...this.base(failed ? "tool.call.failed" : "tool.call.completed", "shell:" + first.slice(0, 40)), category: "tool",
        status: failed ? "error" : "ok", ...(num(item.duration_ms) !== undefined ? { durationMs: num(item.duration_ms) } : {}),
        attributes: { tool: "shell", program: first.slice(0, 40), commandBytes: Buffer.byteLength(command, "utf8"), ...(exitCode !== undefined ? { exitCode } : {}), outputBytes: Buffer.byteLength(str(item.aggregated_output) ?? "", "utf8") },
        ...(this.emitter.capturePolicy === "safe_summary" ? { summary: { text: command.slice(0, 512), policy: "safe_summary" as const } } : {}),
        ...(failed ? { error: { type: "exit_code", message: "exit code " + String(exitCode) } } : {}) });
    } else if (kind === "file_change") {
      const changes = Array.isArray(item.changes) ? (item.changes as Array<Record<string, unknown>>) : [];
      const count = (k: string) => changes.filter((c) => str(c.kind) === k).length;
      this.emitter.emit({ ...this.base("workspace.changed", "workspace.changed"), category: "workspace", status: "ok",
        attributes: { fileCount: changes.length, added: count("add"), updated: count("update"), deleted: count("delete") },
        ...(this.emitter.capturePolicy === "safe_summary" ? { summary: { text: changes.map((c) => str(c.path) ?? "?").slice(0, 20).join(", "), policy: "safe_summary" as const } } : {}) });
    } else if (kind === "mcp_tool_call" || kind === "web_search") {
      this.sawTool = true;
      this.emitter.emit({ ...this.base("tool.call.completed", kind), category: "tool", status: str(item.status) === "failed" ? "error" : "ok", attributes: { tool: kind } });
    }
    // agent_message: final output, handled by the runner; reasoning: deliberately never captured.
  }
  onTurnCompleted(usage: Record<string, unknown>): void {
    this.sawModel = true;
    this.emitter.emit({ ...this.base("model.completed", "model.completed"), category: "model", status: "ok",
      attributes: { ...(num(usage.input_tokens) !== undefined ? { inputTokens: num(usage.input_tokens) } : {}), ...(num(usage.cached_input_tokens) !== undefined ? { cachedInputTokens: num(usage.cached_input_tokens) } : {}), ...(num(usage.output_tokens) !== undefined ? { outputTokens: num(usage.output_tokens) } : {}) } });
  }
  onError(message: string): void {
    this.emitter.emit({ ...this.base("error.recorded", "codex.error"), category: "runtime", status: "error", error: { type: "codex_error", message: message.slice(0, 2048) } });
  }
  finish(): void {
    if (this.finished) return; this.finished = true;
    if (!this.sawTool && !this.sawModel) {
      this.emitter.emit({ ...this.base("capability.unavailable", "capability.unavailable"), category: "runtime", status: "unset", attributes: { model: false, tool: false } });
    }
  }
}
```

`codex-runner.ts` — extend `parseCodexEventLine(line, parsed, sink?)`: call `sink?.onThreadStarted(event.thread_id)` in the `thread.started` branch; in the `item.completed` branch call `sink?.onItemCompleted(item)` *before* the `agent_message` check; `sink?.onTurnCompleted(usage)` in `turn.completed`; `sink?.onError(message)` in `error`. Import `type CodexStreamSink` from `./glassbox/codex-observer.js`.

`CodexRunner.run()` — at the top after the active-check:
```ts
    const timeoutMs = request.timeoutMs ?? this.config.codexTimeoutMs;
    const span = request.trace ? this.emitter.startSpan({ traceId: request.trace.traceId, runId: request.trace.runId, agentId: request.trace.agentId, parentSpanId: request.trace.parentSpanId,
      type: "runtime.codex.started", category: "runtime", name: "codex exec", source: { component: "AgentRunner", adapter: "CodexRunner", observed: true },
      attributes: { sandbox: this.config.codexSandboxMode, resume: request.threadId !== null, timeoutMs, ...(request.timeoutMs !== undefined ? { demoFailure: "timeout" } : {}) } }) : undefined;
    const observer = request.trace && span ? new CodexStreamObserver(this.emitter, request.trace, span.spanId, "CodexRunner") : undefined;
```
Use `timeoutMs` in the `setTimeout`. Pass `observer` as the third argument to every `parseCodexEventLine(...)` call. In the `try` block, before each `throw`, and on success, end the span:
```ts
      observer?.finish();
      const endAttrs = { exitCode, ...(active.forceKillTimer ? { terminationSignal: "SIGKILL" } : {}), ...(observer?.sessionId ? { sessionId: observer.sessionId } : {}) };
      if (active.cancelled) { span?.end("cancelled", { type: "runtime.codex.failed", attributes: { ...endAttrs, terminationSignal: "SIGTERM" }, error: { type: "cancelled", message: "Run cancelled" } }); throw new RunCancelledError(); }
      if (active.timedOut) { span?.end("timeout", { type: "runtime.codex.failed", attributes: { ...endAttrs, terminationSignal: "SIGTERM" }, error: { type: "timeout", message: "Codex timed out after " + timeoutMs + " ms" } }); throw new Error("Codex timed out after " + timeoutMs + " ms"); }
      if (active.outputExceeded) { this.emitter.emit({ ...(request.trace ? { traceId: request.trace.traceId, runId: request.trace.runId, agentId: request.trace.agentId, parentSpanId: span!.spanId } : { traceId: "", runId: "", agentId: "" }), spanId: newId("spn"), type: "limit.exceeded", category: "runtime", name: "output_cap", status: "error", source: { component: "AgentRunner", adapter: "CodexRunner", observed: true }, attributes: { limit: "CODEX_MAX_OUTPUT_BYTES", bytes: totalBytes } }); span?.end("error", { type: "runtime.codex.failed", attributes: endAttrs, error: { type: "output_cap", message: "Codex output exceeded CODEX_MAX_OUTPUT_BYTES" } }); throw new Error("Codex output exceeded CODEX_MAX_OUTPUT_BYTES"); }
      if (exitCode !== 0) { const detail = parsed.errors.at(-1) ?? stderr.trim() ?? "No error detail"; span?.end("error", { type: "runtime.codex.failed", attributes: endAttrs, error: { type: "exit_code", message: "Codex exited with code " + exitCode + ": " + detail } }); throw new Error("Codex exited with code " + exitCode + ": " + detail); }
      const output = parsed.messages.at(-1)?.trim();
      if (!output) { span?.end("error", { type: "runtime.codex.failed", attributes: endAttrs, error: { type: "no_output", message: "Codex completed without an agent message" } }); throw new Error("Codex completed without an agent message"); }
      span?.end("ok", { type: "runtime.codex.completed", attributes: { ...endAttrs, outputBytes: Buffer.byteLength(output, "utf8") } });
```
(guard the `limit.exceeded` emit with `if (request.trace)` rather than the empty-string fallback; the fallback shown only satisfies the type — do not emit without a trace.) Error messages flow through the redactor, so stderr tails with keys are scrubbed before storage.

`ContainerCodexRunner.run()` — same shape with adapter `"ContainerCodexRunner"`, plus a `runtime.container.started/stopped` wrapper: start a container span *outside* the codex span with attributes `{ engine: this.config.containerEngine, image: this.config.containerRuntimeImage, containerName, cpus, memory, pids }`, and make the codex span its child (pass `parentSpanId: containerSpan.spanId`). On close, end the container span with `type: "runtime.container.stopped"`, `status` mirroring the codex outcome, `attributes: { exitCode, removed: active.termination !== null }`. Use `timeoutMs` for the timer. Pass `observer` to `parseCodexEventLine`.

- [ ] **Step 4: Run tests; extend with the real fixture**

Run: `npm run test -w @launchpad/server -- src/glassbox/codex-observer.test.ts src/codex-runner.test.ts src/container-codex-runner.test.ts` → PASS.
Add one more `it` to `codex-observer.test.ts` that feeds `fixtures/codex-stream/codex-0.111.jsonl` (skip if absent) through `parseCodexEventLine` with an observer and asserts the event types match the mapping table in `docs/CODEX_EVENTS.md` (at minimum: ≥1 `tool.call.*` if the table says `command_execution` was observed; `model.completed` if `turn.completed.usage` was observed).

- [ ] **Step 5: Typecheck, privacy review, commit**

Run `npm run typecheck`; dispatch `glassbox-privacy-reviewer` on the two runners + observer.
```bash
git add apps/server/src
git commit -m "feat(glassbox): runtime/container spans and Codex stream observer with capability flags

Closes #28"
```

---

### Task 9: Query routes (#27)

**Files:**
- Modify: `apps/server/src/app.ts` (routes; the `GET /api/runs/:id` route stays)
- Modify: `apps/web/src/types.ts` (mirror `TraceSummary`, `Span`, `FailureFocus`, `RunListItem`)
- Test: `apps/server/src/app.test.ts` (append)

**Interfaces:**
- Consumes: `buildTrace`, `TraceView`, `TraceSummary` (T5); `TraceStore` (T4); `ObservationEmitter.isDegraded`, `capturePolicy` (T6); `AgentService.listAgents/getRun` and `JsonStore` runs via `service.getRuns` (existing).
- Produces:
  - `GET /api/runs?status&agentId&from&to&limit` → `{ schemaVersion, capturePolicy, runs: RunListItem[] }` where `RunListItem = { runId, traceId, agentId, agentName, status, startedAt?, durationMs?, firstFailingStep?, eventCount, runtime, model, usage?, degraded, truncated, redacted, lastEventAt? }`
  - `GET /api/runs/:runId/trace` → `TraceView` (`{ summary, spans, events }`)
  - `GET /api/traces/:traceId` → same; `GET /api/traces/:traceId/events?category&status&q` → `{ schemaVersion, capturePolicy, events }`

- [ ] **Step 1: Write the failing test**

Append to `app.test.ts`:
```ts
it("lists runs and serves a trace with schemaVersion and capturePolicy", async () => {
  const store = new MemoryTraceStore(); const emitter = new ObservationEmitter({ store, capturePolicy: "metadata_only" });
  const ids = { traceId: "trc_9", runId: "run-9", agentId: "agt-9" };
  emitter.emit({ ...ids, spanId: "root", type: "http.request.received", category: "control", name: "POST", phase: "start", status: "running", source: { component: "Fastify", observed: true } });
  emitter.emit({ ...ids, spanId: "rt", parentSpanId: "root", type: "runtime.codex.started", category: "runtime", name: "codex", phase: "start", status: "running", source: { component: "AgentRunner", observed: true } });
  emitter.emit({ ...ids, spanId: "rt", type: "runtime.codex.failed", category: "runtime", name: "codex", phase: "end", status: "timeout", error: { type: "timeout", message: "Codex timed out after 3000 ms" }, source: { component: "AgentRunner", observed: true } });
  emitter.emit({ ...ids, spanId: "t", parentSpanId: "root", type: "run.timed_out", category: "control", name: "run.timed_out", status: "timeout", source: { component: "AgentService", observed: true } });
  await emitter.flush();
  const svc = { ...service, getRuns: () => [], listAgents: () => [{ id: "agt-9", name: "Nine" }],
    getRun: (id: string) => { if (id !== "run-9") throw new HttpError(404, "Run not found"); return { id, agentId: "agt-9", status: "failed", traceId: "trc_9", createdAt: "2026-08-26T00:00:00.000Z" }; },
    allRuns: () => [{ id: "run-9", agentId: "agt-9", status: "failed", traceId: "trc_9", createdAt: "2026-08-26T00:00:00.000Z" }] } as unknown as AgentService;
  const app = await createApp(loadConfig({ NODE_ENV: "test" }), svc, { emitter, store });
  const list = await app.inject({ method: "GET", url: "/api/runs?limit=10" });
  expect(list.statusCode).toBe(200);
  const body = list.json();
  expect(body.schemaVersion).toBe("1.0"); expect(body.capturePolicy).toBe("metadata_only");
  expect(body.runs[0]).toMatchObject({ runId: "run-9", agentName: "Nine", status: "timeout", firstFailingStep: "codex", eventCount: 4 });
  const trace = await app.inject({ method: "GET", url: "/api/runs/run-9/trace" });
  expect(trace.json().summary.failure).toMatchObject({ kind: "timeout", spanId: "rt", path: ["root", "rt"] });
  expect(trace.json().spans[0].children[0].spanId).toBe("rt");
  expect((await app.inject({ method: "GET", url: "/api/traces/trc_9" })).json().summary.runId).toBe("run-9");
  const filtered = (await app.inject({ method: "GET", url: "/api/traces/trc_9/events?status=timeout" })).json();
  expect(filtered.events.map((e: { type: string }) => e.type)).toEqual(["runtime.codex.failed", "run.timed_out"]);
  expect((await app.inject({ method: "GET", url: "/api/runs/nope/trace" })).statusCode).toBe(404);
  expect((await app.inject({ method: "GET", url: "/api/runs?limit=9999" })).statusCode).toBe(400);
  await app.close();
});
```
Add to `AgentService` a tiny accessor used by the list route: `allRuns(): AgentRun[] { return this.store.snapshot().runs; }` (import `HttpError` in the test).

- [ ] **Step 2: Run → FAIL (404 on new routes)**

- [ ] **Step 3: Implement routes in `app.ts`** (inside `if (glassbox)`, after the existing `/api/runs/:id`):

```ts
    const runsQuery = z.object({ status: z.enum(STATUSES).optional(), agentId: z.string().uuid().optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
    const eventsQuery = z.object({ category: z.enum(CATEGORIES).optional(), status: z.enum(STATUSES).optional(), q: z.string().max(200).optional() });
    const viewFor = async (runId: string): Promise<TraceView> => {
      const events = await glassbox.store.readRun(runId);
      const entry = glassbox.store.listRuns().find((r) => r.runId === runId);
      return buildTrace(events, { capturePolicy: glassbox.emitter.capturePolicy, degraded: glassbox.emitter.isDegraded(runId), truncated: entry?.truncated });
    };
    app.get("/api/runs", async (request) => {
      const q = runsQuery.parse(request.query);
      const agents = new Map(service.listAgents().map((a) => [a.id, a.name]));
      const runs = service.allRuns().filter((r) => (!q.agentId || r.agentId === q.agentId) && (!q.from || r.createdAt >= q.from) && (!q.to || r.createdAt <= q.to))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, q.limit * 2);
      const items = [];
      for (const run of runs) {
        const view = await viewFor(run.id);
        const status = view.summary.eventCount ? view.summary.status : run.status === "completed" ? "ok" : run.status === "failed" ? "error" : run.status === "cancelled" ? "cancelled" : "running";
        if (q.status && status !== q.status) continue;
        const s = view.summary;
        items.push({ runId: run.id, traceId: run.traceId ?? s.traceId, agentId: run.agentId, agentName: agents.get(run.agentId) ?? "", status, startedAt: s.startedAt ?? run.createdAt, durationMs: s.durationMs,
          firstFailingStep: s.firstFailingStep, eventCount: s.eventCount, runtime: config.runtimeProvider, model: config.modelProvider === "ark" ? config.arkModel : config.openaiModel || "openai-default",
          usage: s.usage, degraded: s.degraded, truncated: s.truncated, redacted: s.redactedEvents > 0, lastEventAt: view.events.at(-1)?.timestamp });
        if (items.length >= q.limit) break;
      }
      return { schemaVersion: SCHEMA_VERSION, capturePolicy: glassbox.emitter.capturePolicy, runs: items };
    });
    app.get("/api/runs/:runId/trace", async (request) => { const { runId } = z.object({ runId: z.string().min(1) }).parse(request.params); service.getRun(runId); return viewFor(runId); });
    app.get("/api/traces/:traceId", async (request) => { const { traceId } = z.object({ traceId: z.string().min(1) }).parse(request.params); const runId = glassbox.store.runIdForTrace(traceId); if (!runId) throw new HttpError(404, "Trace not found"); return viewFor(runId); });
    app.get("/api/traces/:traceId/events", async (request) => {
      const { traceId } = z.object({ traceId: z.string().min(1) }).parse(request.params); const q = eventsQuery.parse(request.query);
      const runId = glassbox.store.runIdForTrace(traceId); if (!runId) throw new HttpError(404, "Trace not found");
      const events = (await glassbox.store.readRun(runId)).filter((e) => (!q.category || e.category === q.category) && (!q.status || e.status === q.status) && (!q.q || (e.name + " " + (e.error?.message ?? "")).toLowerCase().includes(q.q.toLowerCase())));
      return { schemaVersion: SCHEMA_VERSION, capturePolicy: glassbox.emitter.capturePolicy, events };
    });
```
Imports: `{ CATEGORIES, SCHEMA_VERSION, STATUSES } from "./glassbox/schema.js"`, `{ buildTrace, type TraceView } from "./glassbox/query.js"`. Note the existing `runIdParams` requires a UUID; the new trace route intentionally accepts any non-empty id and defers to `service.getRun` for 404s.

- [ ] **Step 4: Mirror types in `apps/web/src/types.ts`**

Add `TraceStatus`, `RunListItem`, `TraceSummary`, `FailureFocus`, `Span`, `ObservationEvent` (public fields only) copied from `query.ts`/`schema.ts` shapes.

- [ ] **Step 5: Run tests, typecheck both workspaces, commit**

```bash
git add apps/server/src/app.ts apps/server/src/app.test.ts apps/server/src/agent-service.ts apps/web/src/types.ts
git commit -m "feat(glassbox): runs list and trace query routes

Closes #27"
```

---

### Task 10: Failure fixture verification + cross-surface privacy and degradation tests (#30, #29, #33-backend)

**Files:**
- Create: `apps/server/src/glassbox/glassbox.integration.test.ts`
- Modify: `README.md` (demo steps section: how to trigger the controlled failure)

**Interfaces:**
- Consumes: everything above via the public constructors (`AgentService`, `ObservationEmitter`, `NdjsonTraceStore`, `createApp`).

- [ ] **Step 1: Write the tests**

```ts
// apps/server/src/glassbox/glassbox.integration.test.ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../agent-service.js";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { JsonStore } from "../store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../types.js";
import { WorkspaceManager } from "../workspace.js";
import { ObservationEmitter } from "./emitter.js";
import { NdjsonTraceStore, type TraceStore } from "./store.js";

// Runtime-built fakes — never commit key-shaped literals (GitHub push protection scans file contents).
const ARK = ["ark", "0f0f0f0f", "1a1a", "4b4b", "8c8c", "d0d0d0d0d0d0", "0abc1"].join("-");
const OAI = "sk-proj-" + "abcdefghijklmnopqrstuvwxyz0123456789"; const CANARY = "CANARY-SECRET-777";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

class LeakyRunner implements AgentRunner {
  constructor(private readonly mode: "ok" | "throw" | "timeout") {}
  async run(request: RunnerRequest): Promise<RunnerResult> {
    if (this.mode === "throw") throw new Error("boom " + ARK + " Bearer " + OAI + " " + CANARY);
    if (this.mode === "timeout") throw new Error("Codex timed out after " + String(request.timeoutMs ?? 0) + " ms");
    return { output: "done " + OAI + " " + CANARY, threadId: "thr-" + ARK, usage: { inputTokens: 1, outputTokens: 1 } };
  }
  async cancel() { return false; }
  async isAvailable() { return true; }
}
async function harness(runner: AgentRunner, env: Record<string, string> = {}, store?: TraceStore) {
  const root = await mkdtemp(path.join(tmpdir(), "glassbox-int-")); dirs.push(root);
  const config = loadConfig({ NODE_ENV: "test", APP_DATA_DIR: path.join(root, "data"), AGENT_WORKSPACE_ROOT: path.join(root, "ws"), CODEX_HOME: path.join(root, "codex"), ARK_API_KEY: ARK, ARK_MODEL: "ep-test", GLASSBOX_CAPTURE_POLICY: "safe_summary", ...env });
  const traceStore = store ?? new NdjsonTraceStore(config.traceDirectory); await traceStore.initialize();
  const logs: string[] = [];
  const emitter = new ObservationEmitter({ store: traceStore, capturePolicy: config.glassboxCapturePolicy, extraPatterns: [/CANARY-SECRET-\d+/g], log: (m, meta) => logs.push(m + " " + JSON.stringify(meta)) });
  const service = new AgentService(config, new JsonStore(path.join(root, "data", "db.json")), new WorkspaceManager(path.join(root, "ws")), runner, emitter);
  await service.initialize();
  const app = await createApp(config, service, { emitter, store: traceStore });
  const agent = await service.createAgent({ name: "int", instructions: "keep " + OAI });
  const send = async (content: string) => { const res = await app.inject({ method: "POST", url: "/api/agents/" + agent.id + "/messages", payload: { content } }); const run = res.json().run; for (let i = 0; i < 100; i++) { const r = service.getRun(run.id); if (["completed", "failed", "cancelled"].includes(r.status)) break; await new Promise((r) => setTimeout(r, 10)); } await emitter.flush(); return run.id as string; };
  return { config, service, app, emitter, logs, agent, send, traceStore };
}
const surfaces = async (h: Awaited<ReturnType<typeof harness>>, runId: string) => [
  await readFile(path.join(h.config.traceDirectory, runId + ".ndjson"), "utf8"),
  (await h.app.inject({ method: "GET", url: "/api/runs/" + runId + "/trace" })).body,
  (await h.app.inject({ method: "GET", url: "/api/runs" })).body,
  h.logs.join("\n"),
];

describe("AC-03 privacy across surfaces", () => {
  it.each([["success", "ok"], ["runner throws", "throw"]] as const)("no seeded secret survives (%s)", async (_n, mode) => {
    const h = await harness(new LeakyRunner(mode));
    const runId = await h.send("please use " + ARK + " and " + OAI + " and " + CANARY);
    for (const s of await surfaces(h, runId)) { expect(s).not.toContain("0f0f0f0f"); expect(s).not.toContain("abcdefghijklmnop"); expect(s).not.toContain(CANARY); }
    await h.app.close();
  });
});

describe("AC-05 degraded store", () => {
  it("Run reaches its real result and the trace reports degradation", async () => {
    const failing: TraceStore = { async initialize() {}, async append() { throw new Error("EACCES"); }, async readRun() { return []; }, runIdForTrace() { return undefined; }, listRuns() { return []; }, markTruncated() {} };
    const h = await harness(new LeakyRunner("ok"), {}, failing);
    const runId = await h.send("hi");
    expect(h.service.getRun(runId).status).toBe("completed");
    expect(h.emitter.isDegraded(runId)).toBe(true);
    expect((await h.app.inject({ method: "GET", url: "/api/runs/" + runId + "/trace" })).json().summary.degraded).toBe(true);
    expect(h.logs.some((l) => l.startsWith("telemetry.degraded"))).toBe(true);
    await h.app.close();
  });
});

describe("FR-11 gated failure fixture", () => {
  it("off by default: no timeout override reaches the runner", async () => {
    const seen: RunnerRequest[] = [];
    const spy: AgentRunner = { async run(r) { seen.push(r); return { output: "ok", threadId: null, usage: null }; }, async cancel() { return false; }, async isAvailable() { return true; } };
    const h = await harness(spy); await h.send("x");
    expect(seen[0]!.timeoutMs).toBeUndefined(); await h.app.close();
  });
  it("GLASSBOX_DEMO_FAILURE=timeout yields a deterministic timeout trace twice", async () => {
    const h = await harness(new LeakyRunner("timeout"), { GLASSBOX_DEMO_FAILURE: "timeout" });
    const shapes: string[] = [];
    for (let i = 0; i < 2; i++) { const runId = await h.send("x"); const view = (await h.app.inject({ method: "GET", url: "/api/runs/" + runId + "/trace" })).json(); expect(view.summary.status).toBe("timeout"); expect(view.summary.failure.kind).toBe("timeout"); shapes.push(view.events.map((e: { type: string }) => e.type).join(",")); }
    expect(shapes[0]).toBe(shapes[1]); await h.app.close();
  });
});

describe("AC-06 restart", () => {
  it("rebuilds the index and the interrupted Run reads as cancelled with incomplete spans", async () => {
    const hang: AgentRunner = { run: () => new Promise(() => undefined), async cancel() { return false; }, async isAvailable() { return true; } };
    const h = await harness(hang);
    const res = await h.app.inject({ method: "POST", url: "/api/agents/" + h.agent.id + "/messages", payload: { content: "x" } }); const runId = res.json().run.id as string;
    await new Promise((r) => setTimeout(r, 30)); await h.emitter.flush(); await h.app.close();
    const store2 = new NdjsonTraceStore(h.config.traceDirectory); await store2.initialize();
    const emitter2 = new ObservationEmitter({ store: store2, capturePolicy: "metadata_only" });
    for (const e of store2.listRuns()) emitter2.seedSequence(e.traceId, e.lastSequence);
    const service2 = new AgentService(h.config, new JsonStore(path.join(h.config.dataDirectory, "db.json")), new WorkspaceManager(path.join(path.dirname(h.config.dataDirectory), "ws")), new LeakyRunner("ok"), emitter2);
    await service2.initialize(); await emitter2.flush();
    const app2 = await createApp(h.config, service2, { emitter: emitter2, store: store2 });
    const view = (await app2.inject({ method: "GET", url: "/api/runs/" + runId + "/trace" })).json();
    expect(view.summary.status).toBe("cancelled"); expect(view.summary.incompleteSpans).toBeGreaterThan(0);
    expect(view.events.at(-1).attributes.reason).toBe("server_restart");
    expect(view.events.map((e: { sequence: number }) => e.sequence)).toEqual([...view.events.keys()]);
    await app2.close();
  });
});
```

- [ ] **Step 2: Run → fix any real defects surfaced (do not weaken assertions)**

Run: `npm run test -w @launchpad/server -- src/glassbox/glassbox.integration.test.ts --testTimeout=30000`. Typical fixes: a field bypassing the redactor (route it through `attributes`/`summary`/`error` only), `seedSequence` not applied, `readFile` path when `GLASSBOX_TRACE_DIR` is customised.

- [ ] **Step 3: README demo steps**

Add under README "Validation" (or a new "GlassBox demo" section):
```markdown
### Controlled failure (demo)
Set `GLASSBOX_DEMO_FAILURE=timeout` and restart the server. The next Run goes through the real Runner with a 3 s timeout, producing a `runtime.codex.failed` (timeout) span, cleanup evidence and a `run.timed_out` terminal event. Open `GET /api/runs/<runId>/trace` — `summary.failure.diagnosis` names the failing span. Unset the variable to return to normal. The fixture is off by default and never enabled by `npm run poc`.
```

- [ ] **Step 4: Full check, privacy review, commit**

Run: `npm run check` (Windows: only the known `/tmp` assertion may fail). Dispatch `glassbox-privacy-reviewer` over `apps/server/src/glassbox/` + the seams for a final pass.
```bash
git add apps/server/src/glassbox/glassbox.integration.test.ts README.md
git commit -m "test(glassbox): cross-surface privacy, degraded store, restart and gated failure fixture

Closes #29
Closes #30
Refs #33"
```

---

## Self-review (done while writing)

- **Spec coverage:** FR-01/02 → T7; FR-03 → T7/T8; FR-04 → T6 quarantine; FR-05 → T3 (+T6 fail-closed); FR-06 → T4; FR-07/08/09/10 → T5/T9; FR-11 → T7 (`timeoutMs`) + T8 + T10; AC-01 → T7/T8/T10; AC-02 → T5/T10; AC-03 → T10; AC-04 → T8; AC-05 → T6/T10; AC-06 → T7/T10; AC-07 → every task keeps existing tests green. UX-01/02 (Runs view, Trace detail) are **out of this sprint** by design (Day 4 plan). `redaction.applied` as a separate event is intentionally not emitted — redaction is recorded on the event's `privacy` block (fewer events, same information); note this in `docs/PRD.md` §8 when closing #29.
- **Placeholders:** none; every code step is complete. T2 is a capture task whose fixture content is unknowable in advance — its steps are the exact commands to run.
- **Type consistency:** `RunnerRequest.trace: RunnerTraceContext` (T7) ↔ `CodexStreamObserver(emitter, trace: RunnerTraceContext, parentSpanId, adapter)` (T8) ↔ `startSpan` returning `SpanHandle{spanId,end}` (T6) ↔ `buildTrace(events,{capturePolicy,degraded,truncated})` (T5/T9) ↔ `TraceStore{initialize,append,readRun,runIdForTrace,listRuns,markTruncated}` (T4/T6/T9/T10). `AgentService.allRuns()` is introduced in T9 and used only there.
