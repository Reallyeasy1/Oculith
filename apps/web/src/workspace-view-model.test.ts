import { describe, expect, it } from "vitest";
import type { WorkspaceEntry, WorkspaceListing } from "./types";
import {
  checkNewFilePath,
  childPath,
  describeHistoryEntry,
  flattenWorkspaceTree,
  formatBytes,
  parentPath,
  workspaceSummaryLine,
} from "./workspace-view-model";
import { formatClock } from "./runs-view-model";

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
  it("formats count and the shared formatClock time, singular and plural (#341)", () => {
    const stamp = new Date(2026, 7, 29, 9, 5).toISOString();
    const clock = formatClock(stamp);
    expect(clock).not.toBe("—");
    expect(workspaceSummaryLine(1, stamp)).toBe("1 file · last change " + clock);
    expect(workspaceSummaryLine(12, stamp)).toBe("12 files · last change " + clock);
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

describe("describeHistoryEntry (#66)", () => {
  const base = { at: "2026-08-29T18:04:00.000Z", actor: "operator" };
  it("describes each action with local time, path and size", () => {
    const time = (iso: string) => formatClock(iso);
    const t = time(base.at);
    expect(describeHistoryEntry({ ...base, action: "seed", path: "src/app.ts", bytes: 11 })).toBe(t + " · added src/app.ts (11 B)");
    expect(describeHistoryEntry({ ...base, action: "write", path: "a.md", bytes: 2048 })).toBe(t + " · edited a.md (2.0 KB)");
    expect(describeHistoryEntry({ ...base, action: "delete", path: "old.txt", bytes: 5 })).toBe(t + " · deleted old.txt");
    expect(describeHistoryEntry({ ...base, action: "reset", path: "", bytes: 0 })).toBe(t + " · reset the workspace");
  });
  it("drops the time when the timestamp is unparsable", () => {
    expect(describeHistoryEntry({ at: "garbage", actor: "operator", action: "delete", path: "x", bytes: 0 })).toBe("deleted x");
  });
});

describe("checkNewFilePath (#66)", () => {
  it("trims surrounding whitespace", () => {
    expect(checkNewFilePath("  src/app.ts ")).toEqual({ path: "src/app.ts" });
  });
  it.each([
    ["", "Enter a file path"],
    ["   ", "Enter a file path"],
    // #350: "dir/" used to be silently stripped to a file named "dir" — now rejected like the server.
    ["src/app.ts/", "must not end with a slash"],
    ["dir\\", "must not end with a slash"],
    ["/abs/path.txt", "relative path"],
    ["\\abs\\path.txt", "relative path"],
    ["/", "relative path"],
    ["../escape.txt", "'..'"],
    ["a/../../b", "'..'"],
    ["AGENTS.md", "platform-managed"],
    ["README.md", "platform-managed"],
    [".gitignore", "platform-managed"],
    ["x".repeat(1030), "too long"],
  ])("rejects %j", (input, message) => {
    const result = checkNewFilePath(input);
    expect("error" in result && result.error).toContain(message);
  });
  it("allows a platform file name below the root", () => {
    expect(checkNewFilePath("docs/README.md")).toEqual({ path: "docs/README.md" });
  });
});
