# Codex CLI `--json` event stream (observed)

Every row below was seen in a fixture under `fixtures/codex-stream/` — nothing here is
inferred from Codex source or docs. Captured 2026-08-26 from Codex **0.111.0** (inside
`volc-agent-runtime:local`) and **0.142.3** (Windows host), both against Volcengine Ark.

`codex exec --json` writes one JSON object per line to **stdout**; human-readable logs and
warnings go to stderr and are not part of this contract.

## Observed types

| Version | Top-level `type` | `item.type` | Fields seen | GlassBox mapping | Evidence state |
|---|---|---|---|---|---|
| 0.111 / 0.142 | `thread.started` | — | `thread_id` | `sessionId` backfill (already parsed) | observed |
| 0.111 / 0.142 | `turn.started` | — | *(no other fields)* | ignored | observed |
| 0.111 / 0.142 | `item.started` | `command_execution` | `id`, `command`, `aggregated_output` (empty), `exit_code` (`null`), `status:"in_progress"` | `tool.call.started` (correlate to the completion by `item.id`) | observed |
| 0.111 / 0.142 | `item.completed` | `command_execution` | `id`, `command`, `aggregated_output`, `exit_code`, `status` | `tool.call.completed`; `tool.call.failed` when `exit_code !== 0` | observed |
| 0.142 | `item.completed` | `command_execution` (denied) | same fields, `exit_code:-1`, `status:"declined"` | `tool.call.failed` (denied-by-sandbox reason) | observed |
| 0.111 / 0.142 | `item.completed` | `agent_message` | `id`, `text` | final output = **last** agent message; not stored as trace content | observed |
| 0.111 / 0.142 | `item.completed` | `reasoning` | `id`, `text` | **dropped — no chain-of-thought** | observed (deliberately not mapped) |
| 0.111 / 0.142 | `item.completed` | `error` | `id`, `message` | non-fatal notice; does **not** fail the run | observed |
| 0.111 / 0.142 | `turn.completed` | — | `usage.{input_tokens, cached_input_tokens, output_tokens}`; 0.142 adds `usage.reasoning_output_tokens` | `model.completed` (usage attrs) | observed |
| 0.111 | `error` | — | `message` | retry notice → `runtime.codex.failed` only if the turn also fails | observed |
| 0.111 | `turn.failed` | — | `error.message` (**nested**, not top-level `message`) | `runtime.codex.failed` — authoritative failure | observed |

**Not observed:** no `file_change` item in any capture, and no `item.started` for
`agent_message` / `reasoning` / `error` (those only ever arrived as `item.completed`).

## Traps found while capturing

1. **`turn.failed` puts the message under `error.message`, not `message`.** `parseCodexEventLine`
   currently handles top-level `type:"error"` only, so a failed turn's authoritative message is
   dropped today. Task 8 must read `event.error.message`.
2. **`item.type === "error"` is not a run failure.** Both versions emit
   `{"type":"item.completed","item":{"type":"error","message":"Model metadata for … not found…"}}`
   on *every* successful run with a non-OpenAI model. Mapping it to a failure would mark every
   Ark run as failed.
3. **Retry `error` events are noise before the verdict.** The failing capture has six top-level
   `error` events (5 × "Reconnecting… n/5" + 1 final) followed by one `turn.failed`. Emit one
   error event from `turn.failed` / non-zero exit, not one per `error` line.
4. **`exit_code` is `null` on `item.started`** and `-1` on a sandbox-declined command — a
   truthiness check on `exit_code` would misclassify both.
5. **`usage` keys differ by version:** 0.111 has no `reasoning_output_tokens`. Treat every usage
   field as optional.

## Degradation rule (PRD AC-04)

If a run's stream yields **no** `command_execution`/`file_change` items and no
`turn.completed.usage`, the runner must emit one `capability.unavailable` event rather than a
silently empty trace. `codex-0.111-turn-failed.jsonl` is exactly that shape (`thread.started`
only, then `turn.failed`) and is the fixture to test it against.

### `file_change` is unproven

No capture produced a `file_change` item: Codex only emits one when the model calls the
`apply_patch` tool, and the Ark model used here shells out (`Set-Content` / `echo >`) for every
write, even when explicitly told to use `apply_patch`. So:

- **Do not** guess a `file_change` schema for `workspace.changed`.
- Derive `workspace.changed` from the workspace itself (post-run diff of
  `AGENT_WORKSPACE_ROOT/<agentId>`), or gate it behind "if such an item ever appears".
- If a `file_change` item is ever observed, add a fixture here first, then map it.
