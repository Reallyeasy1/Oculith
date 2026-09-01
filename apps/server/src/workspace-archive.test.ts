import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32 as zlibCrc32, inflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspacePathError } from "./workspace-browse.js";
import {
  contentDispositionAttachment,
  crc32,
  crc32Fallback,
  prepareWorkspaceDownload,
  WorkspaceArchiveTooLargeError,
} from "./workspace-archive.js";

let root: string;
let outside: string;

beforeEach(async () => {
  const base = await mkdtemp(path.join(tmpdir(), "launchpad-archive-"));
  root = path.join(base, "workspace");
  outside = path.join(base, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "secret.txt"), "outside the workspace", "utf8");
});

afterEach(async () => {
  await rm(path.dirname(root), { recursive: true, force: true });
});

interface ReadEntry {
  method: number;
  crc: number;
  content: Buffer;
}

/** Independent structural reader: EOCD → central directory → local headers → data. */
function readZip(zip: Buffer): Map<string, ReadEntry> {
  const eocd = zip.length - 22; // no archive comment is ever written
  expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
  const count = zip.readUInt16LE(eocd + 10);
  expect(zip.readUInt32LE(eocd + 12)).toBe(eocd - zip.readUInt32LE(eocd + 16));
  const entries = new Map<string, ReadEntry>();
  let cursor = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    expect(zip.readUInt32LE(cursor)).toBe(0x02014b50);
    const method = zip.readUInt16LE(cursor + 10);
    const crc = zip.readUInt32LE(cursor + 16);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    expect(zip.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    expect(zip.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8")).toBe(name);
    const dataStart = localOffset + 30 + localNameLength;
    const data = zip.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, { method, crc, content: method === 8 ? inflateRawSync(data) : Buffer.from(data) });
    cursor += 46 + nameLength;
  }
  return entries;
}

describe("prepareWorkspaceDownload — single file", () => {
  it("serves raw bytes with the basename as filename", async () => {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "index.ts"), "export {};\n", "utf8");
    const download = await prepareWorkspaceDownload(root, "src/index.ts");
    expect(download.kind).toBe("file");
    expect(download.filename).toBe("index.ts");
    expect(download.contentType).toBe("application/octet-stream");
    expect(download.body.toString("utf8")).toBe("export {};\n");
  });

  it("serves binary files unmodified", async () => {
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x00, 0x7f]);
    await writeFile(path.join(root, "blob.bin"), bytes);
    const download = await prepareWorkspaceDownload(root, "blob.bin");
    expect(download.body.equals(bytes)).toBe(true);
  });

  it("refuses a file over the byte cap with 413 semantics", async () => {
    await writeFile(path.join(root, "big.bin"), Buffer.alloc(64, 1));
    await expect(prepareWorkspaceDownload(root, "big.bin", { maxTotalBytes: 63 })).rejects.toThrowError(
      WorkspaceArchiveTooLargeError,
    );
  });
});

describe("prepareWorkspaceDownload — archives", () => {
  it("zips the whole workspace (path='') with intact contents and directory entries", async () => {
    await mkdir(path.join(root, "src", "lib"), { recursive: true });
    await mkdir(path.join(root, "empty"));
    await writeFile(path.join(root, "README.md"), "# hi\n", "utf8");
    await writeFile(path.join(root, "src", "index.ts"), "export {};\n".repeat(50), "utf8");
    await writeFile(path.join(root, "src", "lib", "blob.bin"), Buffer.from([1, 0, 2, 0, 3]));
    await writeFile(path.join(root, "src", "empty.txt"), "");

    const download = await prepareWorkspaceDownload(root, "");
    expect(download.kind).toBe("archive");
    expect(download.filename).toBe(path.basename(root) + ".zip");
    expect(download.contentType).toBe("application/zip");

    const entries = readZip(download.body);
    expect([...entries.keys()].sort()).toEqual([
      "README.md",
      "empty/",
      "src/",
      "src/empty.txt",
      "src/index.ts",
      "src/lib/",
      "src/lib/blob.bin",
    ]);
    expect(entries.get("src/index.ts")?.content.toString("utf8")).toBe("export {};\n".repeat(50));
    expect(entries.get("src/index.ts")?.method).toBe(8); // repetitive text deflates
    expect(entries.get("src/lib/blob.bin")?.content.equals(Buffer.from([1, 0, 2, 0, 3]))).toBe(true);
    expect(entries.get("src/empty.txt")?.method).toBe(0);
    expect(entries.get("empty/")?.content.length).toBe(0);
    for (const [, entry] of entries) expect(entry.crc).toBe(zlibCrc32(entry.content));
  });

  it("names a whole-workspace zip from rootStem when given (#437: the Agent's name slug)", async () => {
    await writeFile(path.join(root, "a.txt"), "a", "utf8");
    const download = await prepareWorkspaceDownload(root, "", { rootStem: "demo-agent-workspace" });
    expect(download.filename).toBe("demo-agent-workspace.zip");
    // rootStem never renames a subfolder archive
    await mkdir(path.join(root, "sub"));
    expect((await prepareWorkspaceDownload(root, "sub", { rootStem: "demo-agent-workspace" })).filename).toBe("sub.zip");
  });

  it("zips a subfolder rooted at its own name", async () => {
    await mkdir(path.join(root, "src", "lib"), { recursive: true });
    await writeFile(path.join(root, "src", "lib", "a.ts"), "a", "utf8");
    await writeFile(path.join(root, "top.txt"), "top", "utf8");
    const download = await prepareWorkspaceDownload(root, "src");
    expect(download.filename).toBe("src.zip");
    const entries = readZip(download.body);
    expect([...entries.keys()].sort()).toEqual(["src/", "src/lib/", "src/lib/a.ts"]);
  });

  it("skips symlinks inside the tree — both in-workspace and escaping ones", async () => {
    await writeFile(path.join(root, "real.txt"), "real", "utf8");
    await symlink(path.join(outside, "secret.txt"), path.join(root, "escape-link"));
    await symlink(path.join(root, "real.txt"), path.join(root, "inner-link"));
    const entries = readZip((await prepareWorkspaceDownload(root, "")).body);
    expect([...entries.keys()]).toEqual(["real.txt"]);
    expect(entries.get("real.txt")?.content.toString("utf8")).not.toContain("outside");
  });

  it("refuses archives over the entry cap", async () => {
    await writeFile(path.join(root, "a.txt"), "a", "utf8");
    await writeFile(path.join(root, "b.txt"), "b", "utf8");
    await writeFile(path.join(root, "c.txt"), "c", "utf8");
    await expect(prepareWorkspaceDownload(root, "", { maxEntries: 2 })).rejects.toThrowError(
      WorkspaceArchiveTooLargeError,
    );
  });

  it("refuses archives over the total-byte cap", async () => {
    await writeFile(path.join(root, "a.bin"), Buffer.alloc(40, 1));
    await writeFile(path.join(root, "b.bin"), Buffer.alloc(40, 2));
    await expect(prepareWorkspaceDownload(root, "", { maxTotalBytes: 64 })).rejects.toThrowError(
      WorkspaceArchiveTooLargeError,
    );
  });

  it("clamps pre-1980 mtimes instead of corrupting the DOS date field", async () => {
    await writeFile(path.join(root, "old.txt"), "old", "utf8");
    await utimes(path.join(root, "old.txt"), new Date("1970-01-02"), new Date("1970-01-02"));
    const entries = readZip((await prepareWorkspaceDownload(root, "")).body);
    expect(entries.get("old.txt")?.content.toString("utf8")).toBe("old");
  });
});

describe("prepareWorkspaceDownload — boundary", () => {
  it("rejects escapes with the same proof as browse", async () => {
    await expect(prepareWorkspaceDownload(root, "../outside")).rejects.toThrowError(WorkspacePathError);
    await expect(prepareWorkspaceDownload(root, "/etc/passwd")).rejects.toThrowError(WorkspacePathError);
    await symlink(outside, path.join(root, "link"));
    await expect(prepareWorkspaceDownload(root, "link")).rejects.toThrowError(WorkspacePathError);
  });

  it("surfaces ENOENT for a missing path", async () => {
    await expect(prepareWorkspaceDownload(root, "missing.txt")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("crc32", () => {
  it("both the active implementation and the fallback match node:zlib", () => {
    for (const buffer of [Buffer.alloc(0), Buffer.from("hello"), Buffer.from([0, 255, 1, 254, 127])]) {
      expect(crc32(buffer)).toBe(zlibCrc32(buffer));
      expect(crc32Fallback(buffer)).toBe(zlibCrc32(buffer));
    }
  });
});

describe("contentDispositionAttachment", () => {
  it("keeps plain ASCII names in both parameters", () => {
    expect(contentDispositionAttachment("notes.zip")).toBe(
      'attachment; filename="notes.zip"; filename*=UTF-8\'\'notes.zip',
    );
  });

  it("sanitises quotes and non-ASCII out of the fallback, preserving them RFC-5987-encoded", () => {
    const header = contentDispositionAttachment('résumé ".zip');
    expect(header).toContain('filename="r_sum_ _.zip"');
    expect(header).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9%20%22.zip");
  });
});
