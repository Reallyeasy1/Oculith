import { mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspacePathError } from "./workspace-browse.js";
import {
  deleteWorkspaceFile,
  MAX_SEED_BATCH_BYTES,
  MAX_SEED_FILES,
  MAX_WRITE_FILE_BYTES,
  seedWorkspaceFiles,
  WorkspaceEditError,
  writeWorkspaceFile,
} from "./workspace-edit.js";

let root: string;
let outside: string;

beforeEach(async () => {
  const base = await mkdtemp(path.join(tmpdir(), "launchpad-edit-"));
  root = path.join(base, "workspace");
  outside = path.join(base, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
});

afterEach(async () => {
  await rm(path.dirname(root), { recursive: true, force: true });
});

const upload = (p: string, content: string, encoding: "utf8" | "base64" = "utf8") => ({ path: p, content, encoding });

describe("writeWorkspaceFile", () => {
  it("writes utf8 content and creates parent directories", async () => {
    const receipt = await writeWorkspaceFile(root, upload("src/lib/hello.ts", "export const x = 1;\n"));
    expect(receipt).toEqual({ path: "src/lib/hello.ts", bytes: 20 });
    expect(await readFile(path.join(root, "src", "lib", "hello.ts"), "utf8")).toBe("export const x = 1;\n");
  });

  it("decodes base64 content", async () => {
    const bytes = Buffer.from("binary-ish \u{1F600}", "utf8");
    await writeWorkspaceFile(root, upload("assets/blob.bin", bytes.toString("base64"), "base64"));
    expect(await readFile(path.join(root, "assets", "blob.bin"))).toEqual(bytes);
  });

  it("overwrites an existing file", async () => {
    await writeWorkspaceFile(root, upload("notes.md", "one"));
    await writeWorkspaceFile(root, upload("notes.md", "two"));
    expect(await readFile(path.join(root, "notes.md"), "utf8")).toBe("two");
  });

  it.each([["AGENTS.md"], ["README.md"], [".gitignore"]])(
    "refuses the platform-managed %s",
    async (name) => {
      await expect(writeWorkspaceFile(root, upload(name, "x"))).rejects.toThrowError(/platform-managed/);
    },
  );

  it("allows a platform file name below the root", async () => {
    await expect(writeWorkspaceFile(root, upload("sub/AGENTS.md", "mine"))).resolves.toMatchObject({
      path: "sub/AGENTS.md",
    });
  });

  it.each([
    ["../escape.txt"],
    ["/etc/passwd"],
    ["C:\\evil"],
  ])("rejects the unsafe path %j with WorkspacePathError", async (p) => {
    await expect(writeWorkspaceFile(root, upload(p, "x"))).rejects.toThrowError(WorkspacePathError);
  });

  it("rejects the workspace root and reports invalid base64", async () => {
    await expect(writeWorkspaceFile(root, upload("", "x"))).rejects.toThrowError(/workspace root/);
    await expect(writeWorkspaceFile(root, upload("a.bin", "!!not-base64!!", "base64"))).rejects.toThrowError(
      /not valid base64/,
    );
  });

  it("reports the per-file byte cap, counting decoded bytes", async () => {
    const big = "a".repeat(MAX_WRITE_FILE_BYTES + 1);
    await expect(writeWorkspaceFile(root, upload("big.txt", big))).rejects.toThrowError(/limit is 1 MB per file/);
    await expect(
      writeWorkspaceFile(root, upload("big.bin", Buffer.alloc(MAX_WRITE_FILE_BYTES + 1).toString("base64"), "base64")),
    ).rejects.toThrowError(WorkspaceEditError);
  });

  it.each([
    ["dotenv", "ARK_API_KEY=ark-12345678-1234-1234-1234-123456789abc", /credential/],
    ["env assignment", "MY_SECRET=super-secret-value", /env_assignment/],
    ["pem", "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----", /private_key/],
    ["bearer", "Authorization: Bearer abcdefghijklmnopqrstuvwx", /bearer/],
  ])("refuses content that looks like a credential (%s) and names the rule", async (_label, content, message) => {
    await expect(writeWorkspaceFile(root, upload("config/settings.txt", content))).rejects.toThrowError(message);
    await expect(stat(path.join(root, "config"))).rejects.toThrowError(); // nothing was written
  });

  it("scans base64 uploads too — a secret cannot walk in encoded", async () => {
    const encoded = Buffer.from("OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz", "utf8").toString("base64");
    await expect(writeWorkspaceFile(root, upload("wrapped.bin", encoded, "base64"))).rejects.toThrowError(/credential/);
  });

  it("maps a file-as-parent write to a clean 400-class error without the server path (#344)", async () => {
    await writeFile(path.join(root, "empty.txt"), "", "utf8");
    const error: unknown = await writeWorkspaceFile(root, upload("empty.txt/child.txt", "x")).catch((e) => e);
    expect(error).toBeInstanceOf(WorkspaceEditError);
    expect((error as Error).message).toBe("empty.txt is not a directory");
    expect((error as Error).message).not.toContain(root);
  });

  it.each([
    ["   "],
    ["a//b"],
    ["a/   /b"],
  ])("rejects the path %j with an empty or whitespace-only segment (#344)", async (p) => {
    await expect(writeWorkspaceFile(root, upload(p, "x"))).rejects.toThrowError(/empty or whitespace-only segment/);
  });

  it.each([["dir/"], ["dir\\"], ["dir/ "]])(
    "rejects the directory-shaped path %j (#344)",
    async (p) => {
      await expect(writeWorkspaceFile(root, upload(p, "x"))).rejects.toThrowError(/must not end with a slash/);
    },
  );

  it("still writes into an existing directory after the parent guards (#344 control)", async () => {
    await writeWorkspaceFile(root, upload("nested/first.txt", "one"));
    await expect(writeWorkspaceFile(root, upload("nested/second.txt", "two"))).resolves.toEqual({
      path: "nested/second.txt",
      bytes: 3,
    });
    expect(await readFile(path.join(root, "nested", "second.txt"), "utf8")).toBe("two");
  });

  it("refuses to overwrite a directory", async () => {
    await mkdir(path.join(root, "src"));
    await expect(writeWorkspaceFile(root, upload("src", "x"))).rejects.toThrowError(/is a directory/);
  });
});

describe("seedWorkspaceFiles", () => {
  it("writes every file and reports one receipt per file", async () => {
    const receipts = await seedWorkspaceFiles(root, [
      upload("a.txt", "aa"),
      upload("nested/b.txt", "bbb"),
    ]);
    expect(receipts).toEqual([
      { path: "a.txt", bytes: 2 },
      { path: "nested/b.txt", bytes: 3 },
    ]);
  });

  it("reports the file-count cap", async () => {
    const files = Array.from({ length: MAX_SEED_FILES + 1 }, (_, i) => upload("f" + i + ".txt", "x"));
    await expect(seedWorkspaceFiles(root, files)).rejects.toThrowError(/limit is 20/);
  });

  it("reports the batch byte cap and writes nothing", async () => {
    const half = Buffer.alloc(MAX_SEED_BATCH_BYTES / 2 + 1).toString("base64");
    await expect(
      seedWorkspaceFiles(root, [upload("a.bin", half, "base64"), upload("b.bin", half, "base64")]),
    ).rejects.toThrowError(/limit is 8 MB per batch/);
    await expect(stat(path.join(root, "a.bin"))).rejects.toThrowError();
  });

  it("allows a single file larger than the PUT cap, bounded by the batch cap", async () => {
    const big = Buffer.alloc(MAX_WRITE_FILE_BYTES * 2).toString("base64");
    await expect(seedWorkspaceFiles(root, [upload("big.bin", big, "base64")])).resolves.toMatchObject([
      { path: "big.bin", bytes: MAX_WRITE_FILE_BYTES * 2 },
    ]);
  });

  it("refuses duplicate paths (both separators spell the same file) before writing anything", async () => {
    await expect(
      seedWorkspaceFiles(root, [upload("dir/a.txt", "one"), upload("dir\\a.txt", "two")]),
    ).rejects.toThrowError(/appears twice/);
    await expect(stat(path.join(root, "dir"))).rejects.toThrowError();
  });

  it("a credential anywhere in the batch refuses the whole batch", async () => {
    await expect(
      seedWorkspaceFiles(root, [upload("ok.txt", "fine"), upload("bad.txt", "API_TOKEN=abcdef123456")]),
    ).rejects.toThrowError(/credential/);
    await expect(stat(path.join(root, "ok.txt"))).rejects.toThrowError();
  });
});

describe("deleteWorkspaceFile", () => {
  it("deletes a file and reports its size", async () => {
    await writeFile(path.join(root, "gone.txt"), "12345", "utf8");
    await expect(deleteWorkspaceFile(root, "gone.txt")).resolves.toEqual({ path: "gone.txt", bytes: 5 });
    await expect(stat(path.join(root, "gone.txt"))).rejects.toThrowError();
  });

  it("removes a symlink itself, never its target", async () => {
    const target = path.join(outside, "target.txt");
    await writeFile(target, "keep me", "utf8");
    await symlink(target, path.join(root, "link"));
    // The escaping link is rejected by the path proof — resolveWorkspacePath treats it as outside.
    await expect(deleteWorkspaceFile(root, "link")).rejects.toThrowError(WorkspacePathError);
    // An in-workspace link is removed as a link.
    await writeFile(path.join(root, "inner.txt"), "inner", "utf8");
    await symlink(path.join(root, "inner.txt"), path.join(root, "inner-link"));
    await expect(deleteWorkspaceFile(root, "inner-link")).resolves.toEqual({ path: "inner-link", bytes: 0 });
    expect(await readFile(path.join(root, "inner.txt"), "utf8")).toBe("inner");
    await expect(readlink(path.join(root, "inner-link"))).rejects.toThrowError();
  });

  it("refuses managed files, directories, and missing files distinctly", async () => {
    await expect(deleteWorkspaceFile(root, "AGENTS.md")).rejects.toThrowError(/platform-managed/);
    await mkdir(path.join(root, "dir"));
    await expect(deleteWorkspaceFile(root, "dir")).rejects.toThrowError(/is a directory/);
    await expect(deleteWorkspaceFile(root, "missing.txt")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
