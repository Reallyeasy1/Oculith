import { describe, expect, it } from "vitest";
import { evaluatorLabel, metadataSummary, templateHashDetails } from "./eval-view-model";

describe("evaluatorLabel", () => {
  it("joins evaluator id and version as the provenance label", () => {
    expect(evaluatorLabel({ evaluatorId: "task_completion", evaluatorVersion: 1 })).toBe("task_completion@1");
  });
});

describe("metadataSummary", () => {
  it("renders sorted key: value pairs and an empty string for no metadata", () => {
    expect(metadataSummary({ zulu: true, alpha: 3, beta: null })).toBe("alpha: 3 · beta: null · zulu: true");
    expect(metadataSummary({})).toBe("");
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
