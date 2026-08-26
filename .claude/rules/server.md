---
paths:
  - "apps/server/**"
---

# Server conventions (`@launchpad/server`)

- **Validate at the boundary only.** Every route parses `params`/`body` with zod in `app.ts`; services receive typed input and throw `HttpError(status, message)`. Don't re-validate inside services; don't return zod errors from services.
- **All state changes go through `store.mutate()`**; read with `store.snapshot()`. One `mutate` per logical transaction (e.g. create the Run and link its `traceId` together) so partial writes can't happen.
- **New records extend `Database` in `types.ts`** (bump `version` only if the on-disk shape becomes incompatible and add a migration in `JsonStore.initialize`).
- **ESM with `.js` import extensions**, `exactOptionalPropertyTypes` (optional fields are `x?: T | undefined`), `noUncheckedIndexedAccess` (index results are `T | undefined`).
- **Tests are colocated `*.test.ts`**, vitest only. Stateful tests build the real service on a `mkdtemp` dir with a `FakeRunner`; no module mocks. Never assert on `/tmp/...` literals (Windows CI note in CLAUDE.md).
- **New GlassBox logic lives in `apps/server/src/glassbox/`** (context, emitter, schema, redact, store, query, rollup) as pure functions where possible; adapters stay in `app.ts`, `agent-service.ts`, and the runners and only call the emitter.
- **Runner env allow-lists are explicit** (`childEnvironment()` in both runners). Add a name to both when the Runtime needs it; never spread `process.env`.
- **Public types are mirrored by hand** in `apps/web/src/types.ts` — update both in the same commit.
- **New env vars**: add to the zod schema in `config.ts`, to `.env.example` with a comment, and to the README config table.
