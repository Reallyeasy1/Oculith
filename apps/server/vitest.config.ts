import { defineConfig } from "vitest/config";

// Codex writes clones/sessions under codex-home/ (inside apps/server during local dev);
// without this, vitest's default glob picks up *.test.* files in there.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
