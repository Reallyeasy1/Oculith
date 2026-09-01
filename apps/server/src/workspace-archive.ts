import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { resolveWorkspacePath, WorkspacePathError } from "./workspace-browse.js";

const deflate = promisify(zlib.deflateRaw);

/** Everything is buffered in memory before the response, so both caps are hard refusals (413). */
export const MAX_ARCHIVE_ENTRIES = 10_000;
export const MAX_ARCHIVE_TOTAL_BYTES = 128 * 1024 * 1024;

/** Workspace bigger than the caps → 413 at the boundary, never a truncated archive. */
export class WorkspaceArchiveTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceArchiveTooLargeError";
  }
}

export interface WorkspaceDownload {
  kind: "file" | "archive";
  filename: string;
  contentType: string;
  body: Buffer;
}

export interface ArchiveCaps {
  maxEntries?: number | undefined;
  maxTotalBytes?: number | undefined;
  /** Filename stem for a whole-workspace zip; falls back to the workspace dir's basename. */
  rootStem?: string | undefined;
}

/**
 * Prepare `requested` (proved inside `root` first) for download: a regular file is served as-is;
 * a directory — or `""` for the whole workspace — becomes a zip of that subtree. Symlinks inside
 * the tree are skipped entirely (the direct-request realpath proof does not cover link targets
 * reached during a walk), and entries that vanish mid-walk are skipped, never a 500.
 */
export async function prepareWorkspaceDownload(
  root: string,
  requested: string,
  caps: ArchiveCaps = {},
): Promise<WorkspaceDownload> {
  const { relative, absolute } = await resolveWorkspacePath(root, requested);
  const maxTotalBytes = caps.maxTotalBytes ?? MAX_ARCHIVE_TOTAL_BYTES;
  const info = await stat(absolute);
  if (info.isFile()) {
    if (info.size > maxTotalBytes) {
      throw new WorkspaceArchiveTooLargeError("File exceeds the " + megabytes(maxTotalBytes) + " download limit");
    }
    const body = await readFile(absolute);
    // Recount after the read: a Run appending to the file between stat and readFile (downloads
    // are allowed while busy) must not smuggle an unbounded buffer past the cap.
    if (body.length > maxTotalBytes) {
      throw new WorkspaceArchiveTooLargeError("File exceeds the " + megabytes(maxTotalBytes) + " download limit");
    }
    return {
      kind: "file",
      filename: path.posix.basename(relative),
      contentType: "application/octet-stream",
      body,
    };
  }
  if (!info.isDirectory()) throw new WorkspacePathError("Path is not a file or directory");
  const entries: ZipEntry[] = [];
  const prefix = relative === "" ? "" : path.posix.basename(relative);
  if (prefix !== "") entries.push({ name: prefix + "/", mtimeMs: info.mtimeMs });
  await collectEntries(absolute, prefix, entries, {
    maxEntries: caps.maxEntries ?? MAX_ARCHIVE_ENTRIES,
    maxTotalBytes,
    totalBytes: 0,
  });
  const stem =
    relative === "" ? caps.rootStem || path.basename(path.resolve(root)) : path.posix.basename(relative);
  return {
    kind: "archive",
    filename: stem + ".zip",
    contentType: "application/zip",
    body: await buildZip(entries),
  };
}

/** `filename*` (RFC 5987) carries the real UTF-8 name; the quoted fallback is ASCII-sanitised. */
export function contentDispositionAttachment(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return 'attachment; filename="' + fallback + "\"; filename*=UTF-8''" + encoded;
}

interface ZipEntry {
  /** Forward-slash path inside the archive; directories carry a trailing `/`. */
  name: string;
  mtimeMs: number;
  /** undefined = directory entry. */
  content?: Buffer | undefined;
}

interface WalkBudget {
  maxEntries: number;
  maxTotalBytes: number;
  totalBytes: number;
}

async function collectEntries(absolute: string, prefix: string, out: ZipEntry[], budget: WalkBudget): Promise<void> {
  // Sorted for a deterministic archive; dirents re-stat-ed individually so a file deleted
  // mid-walk is skipped (same stance as browseWorkspace).
  const dirents = (await readdir(absolute, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const dirent of dirents) {
    if (dirent.isSymbolicLink()) continue;
    const childAbsolute = path.join(absolute, dirent.name);
    const childName = prefix === "" ? dirent.name : prefix + "/" + dirent.name;
    if (out.length >= budget.maxEntries) {
      throw new WorkspaceArchiveTooLargeError("Too many files to archive (limit " + budget.maxEntries + " entries)");
    }
    try {
      if (dirent.isDirectory()) {
        const info = await stat(childAbsolute);
        out.push({ name: childName + "/", mtimeMs: info.mtimeMs });
        await collectEntries(childAbsolute, childName, out, budget);
      } else if (dirent.isFile()) {
        const info = await stat(childAbsolute);
        assertArchiveBytes(budget, budget.totalBytes + info.size); // cheap refusal before reading a huge file
        const content = await readFile(childAbsolute);
        // Recount with what was actually read: a Run appending between stat and readFile
        // (downloads are allowed while busy) must not smuggle unbounded buffers past the cap.
        budget.totalBytes += content.length;
        assertArchiveBytes(budget, budget.totalBytes);
        out.push({ name: childName, mtimeMs: info.mtimeMs, content });
      }
      // Sockets, FIFOs, devices: silently skipped.
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Gone mid-walk or unreadable (a Run can chmod 000 a dir): skip the entry, keep the archive.
      if (code === "ENOENT" || code === "EACCES" || code === "EPERM") continue;
      throw error;
    }
  }
}

function assertArchiveBytes(budget: WalkBudget, total: number): void {
  if (total > budget.maxTotalBytes) {
    throw new WorkspaceArchiveTooLargeError(
      "Archive exceeds the " + megabytes(budget.maxTotalBytes) + " limit — download folders individually",
    );
  }
}

const megabytes = (bytes: number): string => Math.round(bytes / (1024 * 1024)) + " MB";

// --- Minimal zip writer (APPNOTE 4.4.x subset: deflate or stored, UTF-8 names, no zip64). ---
// Dependency-free by design (#66 set the precedent); the caps above keep every count and size
// far inside the 16-bit/32-bit fields, so zip64 records are never needed.

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

/** Byte-wise fallback; ~250x slower than the zlib native path, kept only for Node 22.0/22.1. */
export function crc32Fallback(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// zlib.crc32 landed in Node 22.2; engines only pin >=22, and a synchronous JS loop over a
// cap-sized archive would stall the event loop (and a live Run's stdout handling) for seconds.
export const crc32: (buffer: Buffer) => number =
  typeof zlib.crc32 === "function" ? (buffer) => zlib.crc32(buffer) >>> 0 : crc32Fallback;

/** MS-DOS packed date/time (2-second resolution, floor-clamped to 1980). */
function dosDateTime(mtimeMs: number): { time: number; date: number } {
  const d = new Date(mtimeMs);
  if (d.getFullYear() < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const UTF8_NAMES_FLAG = 0x0800;

async function buildZip(entries: ZipEntry[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    // The zip name field is u16-sized; the entry budget permits nesting deep enough to overflow it.
    if (name.length > 0xffff) throw new WorkspacePathError("An entry path is too long to archive");
    const raw = entry.content ?? Buffer.alloc(0);
    const deflated = raw.length > 0 ? await deflate(raw) : Buffer.alloc(0);
    // Stored wins for empty and already-compressed content; deflate otherwise.
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const checksum = crc32(raw);
    const { time, date } = dosDateTime(entry.mtimeMs);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(UTF8_NAMES_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    chunks.push(local, name, data);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4); // version made by
    record.writeUInt16LE(20, 6); // version needed
    record.writeUInt16LE(UTF8_NAMES_FLAG, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt16LE(time, 12);
    record.writeUInt16LE(date, 14);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(raw.length, 24);
    record.writeUInt16LE(name.length, 28);
    // extra/comment lengths, disk number, internal/external attributes: all zero.
    record.writeUInt32LE(offset, 42);
    central.push(record, name);

    offset += local.length + name.length + data.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, end]);
}
