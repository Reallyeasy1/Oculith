import { lstat, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export const MAX_BROWSE_ENTRIES = 2_000;
export const MAX_TEXT_FILE_BYTES = 256 * 1024;
/** Written into every workspace root by WorkspaceManager (create/writeInstructions). */
const PLATFORM_FILES = new Set(["AGENTS.md", "README.md", ".gitignore"]);

export interface WorkspaceEntry {
  name: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  mtime: string;
}

export interface WorkspaceListing {
  path: string;
  entries: WorkspaceEntry[];
  truncated: boolean;
}

export interface WorkspaceFileView {
  path: string;
  size: number;
  mtime: string;
  encoding: "utf8" | "binary";
  managed: boolean;
  content?: string | undefined;
}

/** A request that names something outside the workspace, or of the wrong kind → 400 at the boundary. */
export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

/**
 * Prove `requested` stays inside `root` before any filesystem read. Rejects NUL bytes, absolute
 * paths (POSIX and Windows forms), drive-relative `C:x` / ADS segments (any `:`), and `..`;
 * a symlink escape is caught by comparing the realpath of the deepest existing ancestor of the
 * resolved path against the realpath of the root.
 */
export async function resolveWorkspacePath(
  root: string,
  requested: string,
): Promise<{ relative: string; absolute: string }> {
  if (requested.includes("\0")) throw new WorkspacePathError("Path contains a NUL byte");
  if (path.posix.isAbsolute(requested) || path.win32.isAbsolute(requested)) {
    throw new WorkspacePathError("Path must be relative to the workspace");
  }
  // Both separators: Codex on Windows writes files the browser must reach with either form.
  const segments = requested.split(/[\\/]+/).filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) throw new WorkspacePathError("Path may not contain '..'");
  // `:` covers drive-relative Windows paths (`C:evil` is not isAbsolute) and NTFS alternate streams.
  if (segments.some((segment) => segment.includes(":"))) {
    throw new WorkspacePathError("Path contains an invalid character");
  }
  const rootResolved = path.resolve(root);
  const absolute = path.resolve(rootResolved, ...segments);
  if (absolute !== rootResolved && !absolute.startsWith(rootResolved + path.sep)) {
    throw new WorkspacePathError("Path escapes the workspace");
  }
  await assertRealPathInside(rootResolved, absolute);
  return { relative: segments.join("/"), absolute };
}

async function assertRealPathInside(root: string, absolute: string): Promise<void> {
  const rootReal = await realpath(root);
  // Walk up from the requested path to the deepest ancestor that exists; its realpath must stay
  // inside the workspace. This is what catches `link/secret` when `link` points outside the root.
  let probe = absolute;
  for (;;) {
    let real: string;
    try {
      real = await realpath(probe);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code === "ENOENT" || code === "ENOTDIR") && probe !== root) {
        probe = path.dirname(probe);
        continue;
      }
      throw error;
    }
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
      throw new WorkspacePathError("Path escapes the workspace");
    }
    return;
  }
}

export async function browseWorkspace(root: string, requested: string): Promise<WorkspaceListing> {
  const { relative, absolute } = await resolveWorkspacePath(root, requested);
  const info = await stat(absolute);
  if (!info.isDirectory()) throw new WorkspacePathError("Path is not a directory");
  const entries: WorkspaceEntry[] = [];
  for (const dirent of await readdir(absolute, { withFileTypes: true })) {
    // An entry removed mid-walk is skipped, never a 500 (same stance as WorkspaceManager.list).
    try {
      const child = await lstat(path.join(absolute, dirent.name));
      entries.push({
        name: dirent.name,
        kind: child.isSymbolicLink() ? "symlink" : child.isDirectory() ? "dir" : "file",
        size: child.size,
        mtime: new Date(child.mtimeMs).toISOString(),
      });
    } catch {
      continue;
    }
  }
  entries.sort((left, right) =>
    (left.kind === "dir") === (right.kind === "dir")
      ? left.name.localeCompare(right.name)
      : left.kind === "dir" ? -1 : 1,
  );
  const truncated = entries.length > MAX_BROWSE_ENTRIES;
  return { path: relative, entries: truncated ? entries.slice(0, MAX_BROWSE_ENTRIES) : entries, truncated };
}

export async function readWorkspaceFileView(root: string, requested: string): Promise<WorkspaceFileView> {
  const { relative, absolute } = await resolveWorkspacePath(root, requested);
  // stat (not lstat): a symlinked file inside the workspace is served; an escaping one was
  // already rejected by the realpath containment proof above.
  const info = await stat(absolute);
  if (!info.isFile()) throw new WorkspacePathError("Path is not a regular file");
  const base = {
    path: relative,
    size: info.size,
    mtime: new Date(info.mtimeMs).toISOString(),
    managed: PLATFORM_FILES.has(relative),
  };
  if (info.size > MAX_TEXT_FILE_BYTES) {
    return { ...base, encoding: (await sniffBinary(absolute)) ? "binary" : "utf8" };
  }
  const buffer = await readFile(absolute);
  if (buffer.includes(0)) return { ...base, encoding: "binary" };
  try {
    return { ...base, encoding: "utf8", content: new TextDecoder("utf-8", { fatal: true }).decode(buffer) };
  } catch {
    return { ...base, encoding: "binary" };
  }
}

async function sniffBinary(absolute: string): Promise<boolean> {
  const handle = await open(absolute, "r");
  try {
    const probe = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
    return probe.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}
