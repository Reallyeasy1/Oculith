import { describe, expect, it } from "vitest";
import { templateHashDetails } from "./eval-view-model";

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
