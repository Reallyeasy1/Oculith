import { lstat, mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactText } from "./glassbox/redact.js";
import { isPlatformFile, resolveWorkspacePath } from "./workspace-browse.js";

/** "New file"/Edit go through the single-file PUT; browser uploads use the batch seed (#66). */
export const MAX_WRITE_FILE_BYTES = 1024 * 1024;
export const MAX_SEED_FILES = 20;
export const MAX_SEED_BATCH_BYTES = 8 * 1024 * 1024;

export interface WorkspaceUpload {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
}

export interface WorkspaceWriteReceipt {
  path: string;
  bytes: number;
}

/** A refused write: managed file, over a cap, bad base64, or content that looks like a credential → 400. */
export class WorkspaceEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceEditError";
  }
}

const formatMib = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(0) + " MB";

/**
 * Validate one upload without touching the filesystem beyond the containment proof: path proof is the
 * same `resolveWorkspacePath` the read-only browser uses, managed files are refused (edit the Agent
 * instead), and the decoded bytes are scanned with the GlassBox redaction patterns — the sandbox has
 * outbound network, so a file that looks like a credential is refused outright rather than stored (#66).
 */
async function prepareUpload(
  root: string,
  upload: WorkspaceUpload,
  maxBytes: number,
): Promise<{ relative: string; absolute: string; buffer: Buffer }> {
  const { relative, absolute } = await resolveWorkspacePath(root, upload.path);
  if (relative === "") throw new WorkspaceEditError("Path names the workspace root, not a file");
  if (isPlatformFile(relative)) {
    throw new WorkspaceEditError(relative + " is platform-managed — edit the Agent instead");
  }
  let buffer: Buffer;
  if (upload.encoding === "base64") {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(upload.content.replace(/\s+/g, ""))) {
      throw new WorkspaceEditError(relative + ": content is not valid base64");
    }
    buffer = Buffer.from(upload.content, "base64");
  } else {
    buffer = Buffer.from(upload.content, "utf8");
  }
  if (buffer.length > maxBytes) {
    throw new WorkspaceEditError(
      relative + " is " + buffer.length + " bytes — the limit is " + formatMib(maxBytes) + " per file",
    );
  }
  // Lossy utf8 view of the bytes: precise enough that binary rarely trips it, and a PEM block or
  // KEY=value pair inside any upload still fires. Fail closed — never store what looks like a secret.
  const scan = redactText(buffer.toString("utf8"));
  if (scan.rules.length > 0) {
    throw new WorkspaceEditError(
      relative + " looks like it contains a credential (" + scan.rules.join(", ") + ") — remove the secret and retry",
    );
  }
  return { relative, absolute, buffer };
}

async function writePrepared(prepared: { relative: string; absolute: string; buffer: Buffer }): Promise<WorkspaceWriteReceipt> {
  // Refuse to clobber a directory before writeFile turns it into an opaque EISDIR 500.
  try {
    if ((await lstat(prepared.absolute)).isDirectory()) {
      throw new WorkspaceEditError(prepared.relative + " is a directory");
    }
  } catch (error) {
    if (error instanceof WorkspaceEditError) throw error;
    // ENOENT: new file — fine. Anything else surfaces from writeFile below with a real path attached.
  }
  await mkdir(path.dirname(prepared.absolute), { recursive: true });
  await writeFile(prepared.absolute, prepared.buffer);
  return { path: prepared.relative, bytes: prepared.buffer.length };
}

export async function writeWorkspaceFile(root: string, upload: WorkspaceUpload): Promise<WorkspaceWriteReceipt> {
  return writePrepared(await prepareUpload(root, upload, MAX_WRITE_FILE_BYTES));
}

/**
 * Batch seed: everything is validated (paths, caps, credential scan, duplicates) before the first
 * byte is written, so a refused batch leaves the workspace untouched. Per-file size is bounded only
 * by the batch cap — browser uploads of a single large asset stay possible (#66).
 */
export async function seedWorkspaceFiles(root: string, uploads: WorkspaceUpload[]): Promise<WorkspaceWriteReceipt[]> {
  if (uploads.length > MAX_SEED_FILES) {
    throw new WorkspaceEditError(uploads.length + " files in one batch — the limit is " + MAX_SEED_FILES);
  }
  const prepared = [];
  let total = 0;
  const seen = new Set<string>();
  for (const upload of uploads) {
    const item = await prepareUpload(root, upload, MAX_SEED_BATCH_BYTES);
    if (seen.has(item.relative)) throw new WorkspaceEditError(item.relative + " appears twice in the batch");
    seen.add(item.relative);
    total += item.buffer.length;
    if (total > MAX_SEED_BATCH_BYTES) {
      throw new WorkspaceEditError(
        "Batch is " + total + " bytes — the limit is " + formatMib(MAX_SEED_BATCH_BYTES) + " per batch",
      );
    }
    prepared.push(item);
  }
  const receipts = [];
  for (const item of prepared) receipts.push(await writePrepared(item));
  return receipts;
}

/** Delete one file or symlink (the link itself, never its target). Directories and managed files are refused. */
export async function deleteWorkspaceFile(root: string, requested: string): Promise<WorkspaceWriteReceipt> {
  const { relative, absolute } = await resolveWorkspacePath(root, requested);
  if (relative === "") throw new WorkspaceEditError("Path names the workspace root, not a file");
  if (isPlatformFile(relative)) {
    throw new WorkspaceEditError(relative + " is platform-managed — edit the Agent instead");
  }
  const info = await lstat(absolute);
  if (info.isDirectory()) throw new WorkspaceEditError(relative + " is a directory — delete its files instead");
  await unlink(absolute);
  return { path: relative, bytes: info.isSymbolicLink() ? 0 : info.size };
}
