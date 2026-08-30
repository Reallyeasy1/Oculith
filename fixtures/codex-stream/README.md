# Codex `exec --json` stream fixtures

Real, unedited-except-for-scrubbing JSONL captured from `codex exec --json` against the
Volcengine Ark Responses API (model `deepseek-v4-flash-ga-260731`). These exist so the
GlassBox stream→trace mapping is written against observed field names, not guessed ones.
See `docs/CODEX_EVENTS.md` for the mapping table.

| File | Codex | Where | Prompt / condition |
|---|---|---|---|
| `codex-0.111.jsonl` | 0.111.0 | `volc-agent-runtime:local` container (`sh`/`bash` shell) | "Create hello.txt containing the word hello, then run: cat hello.txt" — succeeds |
| `codex-0.142.jsonl` | 0.142.3 | Windows host (`powershell.exe` shell) | same prompt — succeeds |
| `codex-0.142-sandbox-denied.jsonl` | 0.142.3 | Windows host, `--sandbox workspace-write` | same prompt — the shell call is **declined** by the sandbox (`status:"declined"`, `exit_code:-1`) |
| `codex-0.111-turn-failed.jsonl` | 0.111.0 | container, deliberately invalid `ARK_API_KEY` | provider 401 → retry `error` events → `turn.failed` |

Capture commands are in `.superpowers/sdd/2026-08-26-glassbox-sprint1-observation-plane/task-2-brief.md`.
Host captures used `--sandbox danger-full-access` (except the `-sandbox-denied` one) because
`workspace-write` degrades to read-only on Windows.

The captures contain raw `reasoning` items and that is fine: fixtures are *input* to the mapper, and
invariant 5 governs what the observer stores, not what Codex emits — the tests assert the reasoning
text never reaches the store.

## Scrubbing

Applied to every file before committing:

- `ark-…` / `sk-…` key shapes → `ark-REDACTED` / `sk-REDACTED` (none were actually present —
  Codex never echoes the key)
- `C:\Users\<name>` → `C:\Users\USER` (none were actually present)
- Ark `Request id: <hex>` → `Request id: REDACTED-REQUEST-ID`
- CRLF → LF

Verify before touching these files:

```bash
grep -cE 'ark-[0-9a-f]{8}-|sk-(proj-)?[A-Za-z0-9_-]{20,}' fixtures/codex-stream/*.jsonl   # expect 0
```

Treat these as pristine fixtures: re-capture, don't hand-edit.
