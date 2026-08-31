import { describe, expect, it } from "vitest";
import { preferredPreviewCommand, queuedSentNote, showLastErrorHint } from "./agent-view-model";
import { formatClock } from "./runs-view-model";

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

describe("queuedSentNote (#395)", () => {
  it("surfaces the send moment as visible text when the message waited in the queue", () => {
    const queuedAt = "2026-08-31T13:58:02.000Z";
    const note = queuedSentNote({ createdAt: "2026-08-31T14:03:41.000Z", queuedAt });
    expect(note).toBe("sent " + formatClock(queuedAt));
  });
  it("returns null for a message that never queued", () => {
    expect(queuedSentNote({ createdAt: "2026-08-31T14:03:41.000Z" })).toBeNull();
  });
  it("returns null when both clock readings would print the same string", () => {
    expect(
      queuedSentNote({ createdAt: "2026-08-31T14:03:41.900Z", queuedAt: "2026-08-31T14:03:41.100Z" }),
    ).toBeNull();
  });
  it("returns null instead of rendering a malformed send time", () => {
    expect(queuedSentNote({ createdAt: "2026-08-31T14:03:41.000Z", queuedAt: "not-a-date" })).toBeNull();
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
