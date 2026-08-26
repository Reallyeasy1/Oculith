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
});
