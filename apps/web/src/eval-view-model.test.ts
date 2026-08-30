import { describe, expect, it } from "vitest";
import { evaluatorLabel, metadataParts, templateHashDetails } from "./eval-view-model";

describe("evaluatorLabel", () => {
  it("joins evaluator id and version as the provenance label", () => {
    expect(evaluatorLabel({ evaluatorId: "task_completion", evaluatorVersion: 1 })).toBe("task_completion@1");
  });
});

describe("metadataParts", () => {
  it("humanizes max_duration_ms expected/observed and keeps the raw ms in a title", () => {
    expect(metadataParts({ evaluatorId: "max_duration_ms", metadata: { expected: 302828, observed: 300366 } })).toEqual([
      { text: "expected: 5m 03s", title: "302828 ms" },
      { text: "observed: 5m 00s", title: "300366 ms" },
    ]);
  });

  it("leaves other evaluators' metadata raw and sorted", () => {
    expect(metadataParts({ evaluatorId: "expected_tool", metadata: { observed: "shell:powershell.exe npm", expected: "npm" } })).toEqual([
      { text: "expected: npm" },
      { text: "observed: shell:powershell.exe npm" },
    ]);
    expect(metadataParts({ evaluatorId: "max_duration_ms", metadata: {} })).toEqual([]);
  });
});

describe("templateHashDetails", () => {
  it("sorts template provenance and keeps both display and full hashes", () => {
    expect(templateHashDetails({ templateHashes: {
      zebra: "bbbbbbbb2222",
      alpha: "aaaaaaaa1111",
    } })).toEqual([
      { name: "alpha", hash: "aaaaaaaa1111", shortHash: "aaaaaaaa" },
      { name: "zebra", hash: "bbbbbbbb2222", shortHash: "bbbbbbbb" },
    ]);
  });

  it("returns no provenance for EvalRuns created before template hashing", () => {
    expect(templateHashDetails({})).toEqual([]);
  });
});
