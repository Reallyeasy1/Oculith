import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceManager } from "./workspace.js";
import type { Agent } from "./types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const agent = (workspacePath: string): Agent => ({ id: "agent", name: "Demo", description: "", instructions: "", status: "ready", workspacePath, workspaceName: "demo", workspaceManaged: true, codexThreadId: null, lastError: null, createdAt: "", updatedAt: "" });

describe("Workspace templates", () => {
  it("lists and bounded-copies a template into a new workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workspace-template-")); roots.push(root);
    const templates = path.join(root, "templates"); const source = path.join(templates, "demo");
    await mkdir(path.join(source, "src"), { recursive: true }); await writeFile(path.join(source, "src", "fixture.txt"), "fixture");
    const manager = new WorkspaceManager(path.join(root, "workspaces"), templates); await manager.initialize();
    expect(await manager.listTemplates()).toEqual([{ name: "demo", fileCount: 1, bytes: 7 }]);
    const target = manager.pathForName("demo-workspace"); await manager.create(agent(target), false, "demo");
    expect(await readFile(path.join(target, "src", "fixture.txt"), "utf8")).toBe("fixture");
    expect(await readFile(path.join(target, "AGENTS.md"), "utf8")).toContain("Demo");
  });
  it("does not apply a template to an existing workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workspace-template-")); roots.push(root);
    const templates = path.join(root, "templates"); await mkdir(path.join(templates, "demo"), { recursive: true });
    const manager = new WorkspaceManager(path.join(root, "workspaces"), templates); await manager.initialize();
    const target = manager.pathForName("shared"); await manager.create(agent(target));
    await expect(manager.create(agent(target), true, "demo")).rejects.toThrow("A template requires a new workspace");
  });
  it("keeps a template's README.md and .gitignore; AGENTS.md stays platform-owned", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workspace-template-")); roots.push(root);
    const templates = path.join(root, "templates"); const source = path.join(templates, "demo");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "template readme"); await writeFile(path.join(source, ".gitignore"), "template ignore\n"); await writeFile(path.join(source, "AGENTS.md"), "template agents");
    const manager = new WorkspaceManager(path.join(root, "workspaces"), templates); await manager.initialize();
    const target = manager.pathForName("demo-workspace"); await manager.create(agent(target), false, "demo");
    expect(await readFile(path.join(target, "README.md"), "utf8")).toBe("template readme");
    expect(await readFile(path.join(target, ".gitignore"), "utf8")).toBe("template ignore\n");
    expect(await readFile(path.join(target, "AGENTS.md"), "utf8")).toContain("Platform-managed");
  });
  it("reports a template that breaks the copy limits instead of failing the whole list", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workspace-template-")); roots.push(root);
    const templates = path.join(root, "templates");
    await mkdir(path.join(templates, "good"), { recursive: true }); await writeFile(path.join(templates, "good", "a.txt"), "ok");
    await mkdir(path.join(templates, "huge"), { recursive: true }); await writeFile(path.join(templates, "huge", "blob.bin"), Buffer.alloc(10 * 1024 * 1024 + 1));
    const manager = new WorkspaceManager(path.join(root, "workspaces"), templates); await manager.initialize();
    expect(await manager.listTemplates()).toEqual([
      { name: "good", fileCount: 1, bytes: 2 },
      { name: "huge", error: "Workspace template exceeds copy limits" },
    ]);
  });
});

describe("WorkspaceManager.list", () => {
  it("skips non-conforming directory names and files instead of failing the whole list", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-ws-"));
    roots.push(root);
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
