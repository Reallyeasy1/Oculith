import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  browseWorkspace,
  MAX_BROWSE_ENTRIES,
  MAX_TEXT_FILE_BYTES,
  readWorkspaceFileView,
  resolveWorkspacePath,
  WorkspacePathError,
} from "./workspace-browse.js";

let root: string;
let outside: string;

beforeEach(async () => {
  const base = await mkdtemp(path.join(tmpdir(), "launchpad-browse-"));
  root = path.join(base, "workspace");
  outside = path.join(base, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "secret.txt"), "outside the workspace", "utf8");
});

afterEach(async () => {
  await rm(path.dirname(root), { recursive: true, force: true });
});

describe("resolveWorkspacePath", () => {
  it.each([
    ["", ""],
    [".", ""],
    ["src", "src"],
    ["./src", "src"],
    ["src//lib", "src/lib"],
    ["src/./lib", "src/lib"],
    ["src\\lib", "src/lib"],
    ["missing/never-created.txt", "missing/never-created.txt"],
  ])("accepts %j as %j", async (requested, relative) => {
    const resolved = await resolveWorkspacePath(root, requested);
    expect(resolved.relative).toBe(relative);
    expect(
      resolved.absolute === path.resolve(root) ||
        resolved.absolute.startsWith(path.resolve(root) + path.sep),
    ).toBe(true);
  });

  it.each([
    ["..", "'..'"],
    ["../outside", "'..'"],
    ["src/../../outside", "'..'"],
    ["src/..", "'..'"],
    ["..\\outside", "'..'"],
    ["/etc/passwd", "relative"],
    ["\\etc\\passwd", "relative"],
    ["C:\\evil", "relative"],
    ["C:/evil", "relative"],
    ["\\\\server\\share", "relative"],
    ["C:evil", "invalid character"],
    ["notes.txt:stream", "invalid character"],
    ["a\0b", "NUL"],
  ])("rejects %j", async (requested, messagePart) => {
    await expect(resolveWorkspacePath(root, requested)).rejects.toThrowError(WorkspacePathError);
    await expect(resolveWorkspacePath(root, requested)).rejects.toThrowError(
      new RegExp(messagePart.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
    );
  });

  it("rejects a symlink that escapes the workspace, even under a non-existent tail", async () => {
    await symlink(outside, path.join(root, "link"));
    await expect(resolveWorkspacePath(root, "link/secret.txt")).rejects.toThrowError(WorkspacePathError);
    await expect(resolveWorkspacePath(root, "link")).rejects.toThrowError(WorkspacePathError);
    await expect(resolveWorkspacePath(root, "link/deeper/never-created")).rejects.toThrowError(
      WorkspacePathError,
    );
  });

  it("accepts a symlink that stays inside the workspace", async () => {
    await mkdir(path.join(root, "real"));
    await writeFile(path.join(root, "real", "file.txt"), "inside", "utf8");
    await symlink(path.join(root, "real"), path.join(root, "alias"));
    const resolved = await resolveWorkspacePath(root, "alias/file.txt");
    expect(resolved.relative).toBe("alias/file.txt");
  });
});

describe("browseWorkspace", () => {
  it("lists directories first, then files, alphabetically, with lstat metadata", async () => {
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "zzz.txt"), "z", "utf8");
    await writeFile(path.join(root, "a.txt"), "aa", "utf8");
    await symlink(path.join(root, "src"), path.join(root, "src-link"));
    const listing = await browseWorkspace(root, "");
    expect(listing.path).toBe("");
    expect(listing.truncated).toBe(false);
    expect(listing.entries.map((entry) => entry.name)).toEqual(["docs", "src", "a.txt", "src-link", "zzz.txt"]);
    const file = listing.entries.find((entry) => entry.name === "a.txt")!;
    expect(file).toMatchObject({ kind: "file", size: 2 });
    expect(Date.parse(file.mtime)).not.toBeNaN();
    expect(listing.entries.find((entry) => entry.name === "src-link")!.kind).toBe("symlink");
  });

  it("lists a subdirectory by relative path", async () => {
    await mkdir(path.join(root, "src", "lib"), { recursive: true });
    await writeFile(path.join(root, "src", "index.ts"), "export {};", "utf8");
    const listing = await browseWorkspace(root, "src");
    expect(listing.path).toBe("src");
    expect(listing.entries.map((entry) => [entry.name, entry.kind])).toEqual([
      ["lib", "dir"],
      ["index.ts", "file"],
    ]);
  });

  it("caps a directory at MAX_BROWSE_ENTRIES and flags truncation", async () => {
    await mkdir(path.join(root, "many"));
    await Promise.all(
      Array.from({ length: MAX_BROWSE_ENTRIES + 5 }, (_, index) =>
        writeFile(path.join(root, "many", "file-" + String(index).padStart(4, "0") + ".txt"), "x", "utf8"),
      ),
    );
    const listing = await browseWorkspace(root, "many");
    expect(listing.entries).toHaveLength(MAX_BROWSE_ENTRIES);
    expect(listing.truncated).toBe(true);
  });

  it("refuses to list a file and surfaces ENOENT for a missing directory", async () => {
    await writeFile(path.join(root, "file.txt"), "x", "utf8");
    await expect(browseWorkspace(root, "file.txt")).rejects.toThrowError(WorkspacePathError);
    await expect(browseWorkspace(root, "missing")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("readWorkspaceFileView", () => {
  it("returns utf8 content with metadata for a small text file", async () => {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "app.ts"), "const x = 1;\n", "utf8");
    const view = await readWorkspaceFileView(root, "src/app.ts");
    expect(view).toMatchObject({
      path: "src/app.ts",
      encoding: "utf8",
      managed: false,
      content: "const x = 1;\n",
    });
    expect(view.size).toBe(13);
  });

  it("flags platform files at the workspace root as managed, but not nested namesakes", async () => {
    await writeFile(path.join(root, "AGENTS.md"), "# instructions", "utf8");
    await mkdir(path.join(root, "sub"));
    await writeFile(path.join(root, "sub", "AGENTS.md"), "# not the platform's", "utf8");
    expect((await readWorkspaceFileView(root, "AGENTS.md")).managed).toBe(true);
    expect((await readWorkspaceFileView(root, "sub/AGENTS.md")).managed).toBe(false);
  });

  it("returns metadata only for a binary file", async () => {
    await writeFile(path.join(root, "blob.bin"), Buffer.from([0x89, 0x50, 0x00, 0x47]));
    const view = await readWorkspaceFileView(root, "blob.bin");
    expect(view.encoding).toBe("binary");
    expect(view.content).toBeUndefined();
    expect(view.size).toBe(4);
  });

  it("returns metadata only for invalid UTF-8 without a NUL byte", async () => {
    await writeFile(path.join(root, "latin1.txt"), Buffer.from([0xc3, 0x28, 0xa0, 0xff]));
    const view = await readWorkspaceFileView(root, "latin1.txt");
    expect(view.encoding).toBe("binary");
    expect(view.content).toBeUndefined();
  });

  it("returns metadata only beyond the text size cap", async () => {
    await writeFile(path.join(root, "big.txt"), "a".repeat(MAX_TEXT_FILE_BYTES + 1), "utf8");
    const view = await readWorkspaceFileView(root, "big.txt");
    expect(view.encoding).toBe("utf8");
    expect(view.content).toBeUndefined();
    expect(view.size).toBe(MAX_TEXT_FILE_BYTES + 1);
  });

  it("refuses a directory and surfaces ENOENT for a missing file", async () => {
    await mkdir(path.join(root, "dir"));
    await expect(readWorkspaceFileView(root, "dir")).rejects.toThrowError(WorkspacePathError);
    await expect(readWorkspaceFileView(root, "missing.txt")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
