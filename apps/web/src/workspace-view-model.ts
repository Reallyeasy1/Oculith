import type { WorkspaceHistoryEntry, WorkspaceListing } from "./types";
import { formatClock } from "./runs-view-model";

/** One visible row of the workspace tree: a loaded listing entry at a depth, expandable when a dir. */
export interface WorkspaceRow {
  path: string;
  name: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  mtime: string;
  depth: number;
  expanded: boolean;
  loaded: boolean;
}

export const childPath = (parent: string, name: string): string => (parent ? parent + "/" + name : name);

export const parentPath = (path: string): string => {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
};

/**
 * DFS over the lazily fetched listings (keyed by directory path, "" = the workspace root): an
 * expanded directory contributes its children only once its listing has been loaded.
 */
export function flattenWorkspaceTree(
  listings: ReadonlyMap<string, WorkspaceListing>,
  expanded: ReadonlySet<string>,
): WorkspaceRow[] {
  const rows: WorkspaceRow[] = [];
  const walk = (dir: string, depth: number): void => {
    const listing = listings.get(dir);
    if (!listing) return;
    for (const entry of listing.entries) {
      const full = childPath(dir, entry.name);
      const isExpanded = entry.kind === "dir" && expanded.has(full);
      rows.push({
        path: full,
        name: entry.name,
        kind: entry.kind,
        size: entry.size,
        mtime: entry.mtime,
        depth,
        expanded: isExpanded,
        loaded: listings.has(full),
      });
      if (isExpanded) walk(full, depth + 1);
    }
  };
  walk("", 0);
  return rows;
}

/** Header line of the Workspace panel: "N files · last change <clock>" (from GET /api/workspaces).
 * #341: one clock format across the screen — reuses formatClock from runs-view-model. */
export function workspaceSummaryLine(fileCount?: number, lastModified?: string): string {
  if (fileCount === undefined) return "";
  const files = fileCount === 1 ? "1 file" : fileCount + " files";
  if (!lastModified) return files;
  const at = new Date(lastModified);
  if (Number.isNaN(at.getTime())) return files;
  return files + " · last change " + formatClock(lastModified);
}

export function formatBytes(size: number): string {
  if (size < 1024) return size + " B";
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + " KB";
  return (size / (1024 * 1024)).toFixed(1) + " MB";
}

/** One "Recent changes" line (#66): "18:04 · added src/app.ts (11 B)". Reset has no path or size. */
export function describeHistoryEntry(entry: WorkspaceHistoryEntry): string {
  const at = new Date(entry.at);
  const time = Number.isNaN(at.getTime()) ? "" : formatClock(entry.at) + " · ";
  const verb = { write: "edited", seed: "added", delete: "deleted", reset: "reset the workspace" }[entry.action];
  if (entry.action === "reset") return time + verb;
  const size = entry.action === "delete" ? "" : " (" + formatBytes(entry.bytes) + ")";
  return time + verb + " " + entry.path + size;
}

/**
 * #368: whether `path` exists according to the listings already fetched for the tree — true/false
 * when the parent directory's listing can answer, undefined when it cannot (parent not loaded,
 * or truncated past the 2,000-entry cap). Matching is exact, like the tree itself; the server
 * stays the authority on the actual write.
 */
export function listedFileExists(
  listings: ReadonlyMap<string, WorkspaceListing>,
  path: string,
): boolean | undefined {
  if (path.includes("\\")) return undefined; // backslash paths don't key these listings — let the caller probe
  const listing = listings.get(parentPath(path));
  if (!listing || listing.truncated) return undefined;
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (listing.entries.some((entry) => entry.name === name)) return true;
  // #372 review: on a case-insensitive filesystem (this project's own Windows host included) a
  // case-variant name resolves to the SAME file server-side — an exact-only "false" here would skip
  // the probe and let the write truncate it. Case-insensitive-only match → undefined: the network
  // probe decides per-filesystem, exactly like before the listing short-cut existed.
  const lower = name.toLowerCase();
  if (listing.entries.some((entry) => entry.name.toLowerCase() === lower)) return undefined;
  return false;
}

/** Client-side pre-check for "New file": the server proves the path, this only catches obvious
 * mistakes before a round trip. Returns the trimmed path or an error message. */
export function checkNewFilePath(input: string): { path: string } | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { error: "Enter a file path" };
  // #344: stripping a leading slash silently turned "/abs/path.txt" into "abs/path.txt" — reject instead.
  if (/^[/\\]/.test(trimmed)) return { error: "Use a relative path inside the workspace" };
  // #350: stripping a trailing separator silently turned "dir/" into a file named "dir" — reject
  // instead (the server 400s raw trailing-slash paths too).
  if (/[/\\]$/.test(trimmed)) return { error: "A file path must not end with a slash" };
  const path = trimmed;
  if (path.length > 1024) return { error: "Path is too long (1,024 characters max)" };
  if (path.split(/[/\\]+/).includes("..")) return { error: "Path may not contain '..'" };
  if (["AGENTS.md", "README.md", ".gitignore"].includes(path)) {
    return { error: path + " is platform-managed — edit the Agent instead" };
  }
  return { path };
}
