import type { WorkspaceListing } from "./types";

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

/** Header line of the Workspace panel: "N files · last change hh:mm" (from GET /api/workspaces). */
export function workspaceSummaryLine(fileCount?: number, lastModified?: string): string {
  if (fileCount === undefined) return "";
  const files = fileCount === 1 ? "1 file" : fileCount + " files";
  if (!lastModified) return files;
  const at = new Date(lastModified);
  if (Number.isNaN(at.getTime())) return files;
  const pad = (value: number) => String(value).padStart(2, "0");
  return files + " · last change " + pad(at.getHours()) + ":" + pad(at.getMinutes());
}

export function formatBytes(size: number): string {
  if (size < 1024) return size + " B";
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + " KB";
  return (size / (1024 * 1024)).toFixed(1) + " MB";
}
