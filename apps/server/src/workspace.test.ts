import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceManager } from "./workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("WorkspaceManager.list", () => {
  it("skips non-conforming directory names and files instead of failing the whole list", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-ws-"));
    temporaryDirectories.push(root);
    const manager = new WorkspaceManager(root);
    await manager.initialize();
    await mkdir(path.join(root, "good-repo"));
    await writeFile(path.join(root, "good-repo", "index.js"), "", "utf8");
    for (const bad of ["My-Repo", ".git", "Repo"]) await mkdir(path.join(root, bad));
    await writeFile(path.join(root, "notes.txt"), "", "utf8");

    const listed = await manager.list([]);
    expect(listed.map((workspace) => workspace.name)).toEqual(["good-repo"]);
    expect(listed[0]).toMatchObject({ fileCount: 1, agents: [], managed: false });
  });
});
