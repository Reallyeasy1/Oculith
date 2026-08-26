import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

export const WORKSPACE_SNAPSHOT_CAPS = { entries: 5_000, hashBytes: 4 * 1024 * 1024, paths: 200 } as const;

export interface WorkspaceFileFact { size: number; mtimeMs: number; sha256?: string | undefined }
export interface WorkspaceSnapshot { files: Map<string, WorkspaceFileFact>; truncated: boolean }
export interface WorkspaceChangeSet { added: string[]; modified: string[]; removed: string[]; bytesDelta: number; truncated: boolean }

export async function snapshotWorkspace(root: string): Promise<WorkspaceSnapshot> {
  const files = new Map<string, WorkspaceFileFact>();
  let truncated = false;
  let seen = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (seen >= WORKSPACE_SNAPSHOT_CAPS.entries) { truncated = true; return; }
      seen++;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) { await walk(absolute); if (truncated) return; continue; }
      if (!entry.isFile()) continue;
      const info = await stat(absolute);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      files.set(relative, {
        size: info.size,
        mtimeMs: info.mtimeMs,
        ...(info.size <= WORKSPACE_SNAPSHOT_CAPS.hashBytes
          ? { sha256: createHash("sha256").update(await readFile(absolute)).digest("hex") }
          : {}),
      });
    }
  };
  await walk(root);
  return { files, truncated };
}

export function diffWorkspace(before: WorkspaceSnapshot, after: WorkspaceSnapshot): WorkspaceChangeSet {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  let beforeBytes = 0;
  let afterBytes = 0;
  for (const [name, fact] of before.files) {
    beforeBytes += fact.size;
    const next = after.files.get(name);
    if (!next) removed.push(name);
    else if (fact.size !== next.size || fact.sha256 !== next.sha256 || (fact.sha256 === undefined && fact.mtimeMs !== next.mtimeMs)) modified.push(name);
  }
  for (const [name, fact] of after.files) {
    afterBytes += fact.size;
    if (!before.files.has(name)) added.push(name);
  }
  return { added, modified, removed, bytesDelta: afterBytes - beforeBytes, truncated: before.truncated || after.truncated };
}

export function boundedChangedPaths(changes: WorkspaceChangeSet): string {
  return [...changes.added, ...changes.modified, ...changes.removed]
    .sort()
    .slice(0, WORKSPACE_SNAPSHOT_CAPS.paths)
    .join("\n")
    .slice(0, 2_000);
}
