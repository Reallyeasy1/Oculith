import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { boundedChangedPaths, diffWorkspace, snapshotWorkspace } from "./workspace-snapshot.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("workspace snapshots", () => {
  it("reports path metadata and byte deltas without file contents", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workspace-snapshot-")); dirs.push(root);
    await writeFile(path.join(root, "same.txt"), "same");
    await writeFile(path.join(root, "remove.txt"), "remove");
    const before = await snapshotWorkspace(root);
    await writeFile(path.join(root, "same.txt"), "changed");
    await rm(path.join(root, "remove.txt"));
    await writeFile(path.join(root, "add.txt"), "add");
    const changes = diffWorkspace(before, await snapshotWorkspace(root));
    expect(changes).toMatchObject({ added: ["add.txt"], modified: ["same.txt"], removed: ["remove.txt"] });
    expect(boundedChangedPaths(changes)).toBe("add.txt\nremove.txt\nsame.txt");
    expect(JSON.stringify(changes)).not.toContain("changed");
  });
});
