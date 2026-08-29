// ponytail: one runnable check for the Runtime pane's three states (#200). Run from repo root:
//   npx vitest run apps/web/src/system-view-model.test.ts
import { describe, expect, it } from "vitest";
import type { SystemInfo } from "./types";
import { runtimeCardModel } from "./system-view-model";

function info(extra: Partial<SystemInfo> = {}): SystemInfo {
  return {
    modelConfigured: true, modelProvider: "ark", arkBaseUrl: "https://ark", arkModel: "doubao-seed",
    codexAvailable: true, codexSandboxMode: "workspace-write", runtimeProvider: "local-process",
    containerEngine: null, runtime: "Codex CLI as local process", previewAvailable: false, ...extra,
  };
}

describe("runtimeCardModel", () => {
  it("shows a neutral placeholder while /api/system is in flight — never the warning (#200)", () => {
    expect(runtimeCardModel(null)).toEqual({ state: "loading", runtimeLabel: "Checking…", modelLabel: "—" });
  });

  it("shows the runtime and model once the response says configured", () => {
    expect(runtimeCardModel(info())).toEqual({ state: "configured", runtimeLabel: "Codex CLI as local process", modelLabel: "doubao-seed" });
  });

  // #260: the runtime line is the payload's provider-derived label, never a static string.
  it("shows the local-process label when Runs report local-process", () => {
    expect(runtimeCardModel(info({ runtimeProvider: "local-process", runtime: "Codex CLI as local process" })).runtimeLabel)
      .toBe("Codex CLI as local process");
  });

  it("shows the container-engine label for the container provider", () => {
    expect(runtimeCardModel(info({ runtimeProvider: "container", containerEngine: "docker", runtime: "Codex CLI in docker container" })).runtimeLabel)
      .toBe("Codex CLI in docker container");
  });

  it("falls back to the provider name for a configured provider without an Ark model", () => {
    expect(runtimeCardModel(info({ modelProvider: "openai", arkModel: null })).modelLabel).toBe("openai");
  });

  it("warns only when the response says the model is not configured", () => {
    expect(runtimeCardModel(info({ modelConfigured: false, arkModel: null }))).toEqual({
      state: "not-configured", runtimeLabel: "Codex CLI as local process", modelLabel: "Ark model not configured",
    });
  });

  it("warns when the request failed, instead of a placeholder forever", () => {
    expect(runtimeCardModel(null, true)).toEqual({
      state: "not-configured", runtimeLabel: "Unavailable", modelLabel: "Ark model not configured",
    });
  });
});
