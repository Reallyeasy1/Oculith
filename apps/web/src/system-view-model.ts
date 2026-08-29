import type { SystemInfo } from "./types";

// Pure label derivation for the sidebar Runtime pane (#200): the "not configured"
// warning may only appear when /api/system said so (or the request failed) — never
// while the first fetch is still in flight.

export interface RuntimeCardModel {
  state: "loading" | "configured" | "not-configured";
  runtimeLabel: string;
  modelLabel: string;
}

export function runtimeCardModel(system: SystemInfo | null, loadFailed = false): RuntimeCardModel {
  if (!system) {
    return loadFailed
      ? { state: "not-configured", runtimeLabel: "Unavailable", modelLabel: "Ark model not configured" }
      : { state: "loading", runtimeLabel: "Checking…", modelLabel: "—" };
  }
  if (!system.modelConfigured) {
    return { state: "not-configured", runtimeLabel: system.runtime, modelLabel: "Ark model not configured" };
  }
  // ponytail: openai provider has no arkModel; the provider name is the honest label.
  return { state: "configured", runtimeLabel: system.runtime, modelLabel: system.arkModel ?? system.modelProvider };
}
