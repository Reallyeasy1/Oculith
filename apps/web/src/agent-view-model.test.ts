import { describe, expect, it } from "vitest";
import { preferredPreviewCommand, showLastErrorHint } from "./agent-view-model";

describe("showLastErrorHint (#266)", () => {
  it("shows persisted evidence when no run is on screen (reload / agent switch)", () => {
    expect(showLastErrorHint("Codex exited", null)).toBe(true);
  });
  it("yields to the fresher run surfaces: error card (failed) and activity strip (queued/running)", () => {
    for (const status of ["queued", "running", "failed"] as const) {
      expect(showLastErrorHint("Codex exited", status)).toBe(false);
    }
  });
  it("shows after a terminal run that did not fail while lastError is still set", () => {
    expect(showLastErrorHint("Codex exited", "cancelled")).toBe(true);
  });
  it("never shows without lastError", () => {
    expect(showLastErrorHint(null, null)).toBe(false);
    expect(showLastErrorHint(null, "failed")).toBe(false);
  });
});

describe("preferredPreviewCommand (#370, #375)", () => {
  it("starts the static preview when the workspace has a built dist", () => {
    expect(preferredPreviewCommand({ static: true })).toBe("static");
  });
  it("returns null when nothing is servable — the Preview button stays hidden", () => {
    expect(preferredPreviewCommand({ static: false })).toBeNull();
    expect(preferredPreviewCommand(null)).toBeNull();
  });
});
