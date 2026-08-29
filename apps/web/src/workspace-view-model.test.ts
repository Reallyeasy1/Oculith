import { describe, expect, it } from "vitest";
import type { WorkspaceEntry, WorkspaceListing } from "./types";
import {
  childPath,
  flattenWorkspaceTree,
  formatBytes,
  parentPath,
  workspaceSummaryLine,
} from "./workspace-view-model";

const entry = (name: string, kind: WorkspaceEntry["kind"] = "file"): WorkspaceEntry => ({
  name,
  kind,
  size: 10,
  mtime: "2026-08-29T09:00:00.000Z",
});

const listing = (path: string, entries: WorkspaceEntry[]): [string, WorkspaceListing] => [
  path,
  { path, entries, truncated: false },
];

describe("flattenWorkspaceTree", () => {
  it("returns nothing until the root listing is loaded", () => {
    expect(flattenWorkspaceTree(new Map(), new Set())).toEqual([]);
  });

  it("keeps collapsed directories to one row and preserves server order", () => {
    const listings = new Map([
      listing("", [entry("src", "dir"), entry("README.md")]),
      listing("src", [entry("index.ts")]),
    ]);
    const rows = flattenWorkspaceTree(listings, new Set());
    expect(rows.map((row) => row.path)).toEqual(["src", "README.md"]);
    expect(rows[0]).toMatchObject({ kind: "dir", depth: 0, expanded: false, loaded: true });
  });

  it("inlines an expanded directory's loaded children at depth + 1", () => {
    const listings = new Map([
      listing("", [entry("src", "dir"), entry("README.md")]),
      listing("src", [entry("lib", "dir"), entry("index.ts")]),
      listing("src/lib", [entry("util.ts")]),
    ]);
    const rows = flattenWorkspaceTree(listings, new Set(["src", "src/lib"]));
    expect(rows.map((row) => [row.path, row.depth])).toEqual([
      ["src", 0],
      ["src/lib", 1],
      ["src/lib/util.ts", 2],
      ["src/index.ts", 1],
      ["README.md", 0],
    ]);
  });

  it("marks an expanded but not yet fetched directory as unloaded and adds no children", () => {
    const listings = new Map([listing("", [entry("src", "dir")])]);
    const rows = flattenWorkspaceTree(listings, new Set(["src"]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ expanded: true, loaded: false });
  });

  it("never expands a symlink even when its path is in the expanded set", () => {
    const listings = new Map([
      listing("", [entry("link", "symlink")]),
      listing("link", [entry("should-not-appear")]),
    ]);
    const rows = flattenWorkspaceTree(listings, new Set(["link"]));
    expect(rows.map((row) => row.path)).toEqual(["link"]);
  });
});

describe("path helpers", () => {
  it("joins and splits workspace paths with the root spelled as empty", () => {
    expect(childPath("", "src")).toBe("src");
    expect(childPath("src", "lib")).toBe("src/lib");
    expect(parentPath("src/lib")).toBe("src");
    expect(parentPath("src")).toBe("");
  });
});

describe("workspaceSummaryLine", () => {
  it("formats count and local hh:mm, singular and plural", () => {
    const stamp = new Date(2026, 7, 29, 9, 5).toISOString();
    expect(workspaceSummaryLine(1, stamp)).toBe("1 file · last change 09:05");
    expect(workspaceSummaryLine(12, stamp)).toBe("12 files · last change 09:05");
  });

  it("degrades to just the count without a usable timestamp, and to nothing without a count", () => {
    expect(workspaceSummaryLine(3)).toBe("3 files");
    expect(workspaceSummaryLine(3, "not-a-date")).toBe("3 files");
    expect(workspaceSummaryLine()).toBe("");
  });
});

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [512, "512 B"],
    [2048, "2.0 KB"],
    [262_144, "256.0 KB"],
    [5 * 1024 * 1024, "5.0 MB"],
  ])("formats %d as %s", (size, label) => {
    expect(formatBytes(size)).toBe(label);
  });
});
