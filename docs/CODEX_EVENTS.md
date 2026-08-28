# Codex CLI `--json` event stream (observed)

Every row below was seen in a fixture under `fixtures/codex-stream/` — nothing here is
inferred from Codex source or docs. Each row cites an example ID (`E1`…`E12`); the matching
**verbatim, scrubbed line** — with its fixture filename and line number — is in
[Example lines](#example-lines) below. Captured 2026-08-26 from Codex **0.111.0** (inside
`volc-agent-runtime:local`) and **0.142.3** (Windows host), both against Volcengine Ark.

`codex exec --json` writes one JSON object per line to **stdout**; human-readable logs and
warnings go to stderr and are not part of this contract.

## Observed types

| Version | Top-level `type` | `item.type` | Fields seen | GlassBox mapping | Evidence state | Example |
|---|---|---|---|---|---|---|
| 0.111 / 0.142 | `thread.started` | — | `thread_id` | `sessionId` backfill (already parsed) | observed | E1 |
| 0.111 / 0.142 | `turn.started` | — | *(no other fields)* | `model.request` — `start` of the `model.turn` span (`turnIndex`); marks the model capability observed (#129) | observed | E2 |
| 0.111 / 0.142 | `item.started` | `command_execution` | `id`, `command`, `aggregated_output` (empty), `exit_code` (`null`), `status:"in_progress"` | `tool.call.started` (correlate to the completion by `item.id`) | observed | E3 |
| 0.111 / 0.142 | `item.completed` | `command_execution` | `id`, `command`, `aggregated_output`, `exit_code`, `status` | `tool.call.completed`; `tool.call.failed` when `exit_code !== 0` | observed | E4 |
| 0.142 | `item.completed` | `command_execution` (denied) | same fields, `exit_code:-1`, `status:"declined"` | `tool.call.failed` (denied-by-sandbox reason) | observed | E5 |
| 0.111 / 0.142 | `item.completed` | `agent_message` | `id`, `text` | final output = **last** agent message; counted toward `modelCallsObserved` on the turn end (#207); under `safe_summary` each message also emits a `model.message` event with a redacted 240-char summary (#258 — nothing is emitted at `metadata_only`) | observed | E6 |
| 0.111 / 0.142 | `item.completed` | `reasoning` | `id`, `text` | **raw text never stored**; counted, one model call each, toward `modelCallsObserved` on the turn end (#207); under the opt-in `reasoning_summary` policy ONLY, each item also emits a `model.reasoning` event with a 240-char redacted summary (#259 — nothing is emitted at `metadata_only`/`safe_summary`) | observed | E7 |
| 0.111 / 0.142 | `item.completed` | `error` | `id`, `message` | non-fatal notice; does **not** fail the run | observed | E8 |
| 0.111 | `turn.completed` | — | `usage.{input_tokens, cached_input_tokens, output_tokens}` | `model.completed` — `end` of the open `model.turn` span (usage attrs, #129) | observed | E9 |
| 0.142 | `turn.completed` | — | same plus `usage.reasoning_output_tokens` | `model.completed` — `end` of the open `model.turn` span (usage attrs, #129) | observed | E10 |
| 0.111 | `error` | — | `message` | retry notice → `runtime.codex.failed` only if the turn also fails | observed | E11 |
| 0.111 | `turn.failed` | — | `error.message` (**nested**, not top-level `message`) | `runtime.codex.failed` — authoritative failure | observed | E12 |

**Not observed:** no `file_change` item in any capture, and no `item.started` for
`agent_message` / `reasoning` / `error` (those only ever arrived as `item.completed`).

## Example lines

Each block is copied byte-for-byte out of the named fixture (after the scrubbing described in
`fixtures/codex-stream/README.md`). Re-check any of them with
`sed -n '<line>p' fixtures/codex-stream/<file>`.

**E1** — `fixtures/codex-stream/codex-0.111.jsonl` line 1

```json
{"type":"thread.started","thread_id":"01a03bf8-b3a7-7021-a140-f85469d12671"}
```

**E2** — `fixtures/codex-stream/codex-0.111.jsonl` line 3

```json
{"type":"turn.started"}
```

**E3** — `fixtures/codex-stream/codex-0.111.jsonl` line 5

```json
{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"/bin/bash -lc 'echo hello > hello.txt && cat hello.txt'","aggregated_output":"","exit_code":null,"status":"in_progress"}}
```

**E4** — `fixtures/codex-stream/codex-0.111.jsonl` line 6

```json
{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"/bin/bash -lc 'echo hello > hello.txt && cat hello.txt'","aggregated_output":"hello\n","exit_code":0,"status":"completed"}}
```

**E5** — `fixtures/codex-stream/codex-0.142-sandbox-denied.jsonl` line 7

```json
{"type":"item.completed","item":{"id":"item_3","type":"command_execution","command":"\"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command \"Set-Content -LiteralPath .\\\\hello.txt -Value \\\"hello\\\"; cat .\\\\hello.txt\"","aggregated_output":"`\"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command \"Set-Content -LiteralPath .\\\\hello.txt -Value \\\"hello\\\"; cat .\\\\hello.txt\"` rejected: blocked by policy","exit_code":-1,"status":"declined"}}
```

**E6** — `fixtures/codex-stream/codex-0.111.jsonl` line 7

```json
{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Done. `hello.txt` contains `hello`, and `cat hello.txt` outputs `hello`."}}
```

**E7** — `fixtures/codex-stream/codex-0.111.jsonl` line 4

```json
{"type":"item.completed","item":{"id":"item_1","type":"reasoning","text":"The task is simple: create hello.txt containing \"hello\" and run `cat hello.txt`. Let me do that."}}
```

**E8** — `fixtures/codex-stream/codex-0.111.jsonl` line 2

```json
{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `deepseek-v4-flash-ga-260731` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}
```

**E9** — `fixtures/codex-stream/codex-0.111.jsonl` line 8

```json
{"type":"turn.completed","usage":{"input_tokens":14150,"cached_input_tokens":6912,"output_tokens":97}}
```

**E10** — `fixtures/codex-stream/codex-0.142.jsonl` line 8

```json
{"type":"turn.completed","usage":{"input_tokens":18513,"cached_input_tokens":12288,"output_tokens":141,"reasoning_output_tokens":59}}
```

**E11** — `fixtures/codex-stream/codex-0.111-turn-failed.jsonl` line 4

```json
{"type":"error","message":"Reconnecting... 1/5 (unexpected status 401 Unauthorized: The API key format is incorrect. Request id: REDACTED-REQUEST-ID, url: https://ark.ap-southeast.bytepluses.com/api/v3/responses, request id: REDACTED-REQUEST-ID)"}
```

**E12** — `fixtures/codex-stream/codex-0.111-turn-failed.jsonl` line 10

```json
{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: The API key format is incorrect. Request id: REDACTED-REQUEST-ID, url: https://ark.ap-southeast.bytepluses.com/api/v3/responses, request id: REDACTED-REQUEST-ID"}}
```

## Traps found while capturing

1. **`turn.failed` puts the message under `error.message`, not `message`** (E12).
   `parseCodexEventLine` reads `event.error.message` for `turn.failed` as well as the top-level
   `message` for `type:"error"`, so the authoritative verdict is the last recorded error.
2. **`item.type === "error"` is not a run failure** (E8). Both versions emit that line on
   *every* successful run with a non-OpenAI model. Mapping it to a failure would mark every
   Ark run as failed.
3. **Retry `error` events are noise before the verdict** (E11). The failing capture has six
   top-level `error` events (5 × "Reconnecting… n/5" + 1 final) followed by one `turn.failed`.
   Emit one error event from `turn.failed` / non-zero exit, not one per `error` line.
4. **`exit_code` is `null` on `item.started`** (E3) and `-1` on a sandbox-declined command
   (E5) — a truthiness check on `exit_code` would misclassify both.
5. **`usage` keys differ by version:** 0.111 (E9) has no `reasoning_output_tokens`, 0.142 (E10)
   does. Treat every usage field as optional.

## Degradation rule (PRD AC-04)

If a run's stream yields **no** `command_execution`/`file_change` items and no `turn.started` /
`turn.completed.usage`, the runner must emit one `capability.unavailable` event rather than a
silently empty trace. A `turn.started` is model evidence (#129): `codex-0.111-turn-failed.jsonl`
(`thread.started`, `turn.started`, then `turn.failed`) therefore keeps its open `model.turn` span
plus one `error.recorded` and does **not** degrade.

### `file_change` is unproven

No capture produced a `file_change` item: Codex only emits one when the model calls the
`apply_patch` tool, and the Ark model used here shells out (`Set-Content` / `echo >`) for every
write, even when explicitly told to use `apply_patch`. So:

- **Do not** guess a `file_change` schema for `workspace.changed`.
- Derive `workspace.changed` from the workspace itself (post-run diff of
  `AGENT_WORKSPACE_ROOT/<agentId>`), or gate it behind "if such an item ever appears".
- If a `file_change` item is ever observed, add a fixture here first, then map it.
