import { cp, mkdir, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent } from "./types.js";

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_TEMPLATE_FILES = 1_000;
const MAX_TEMPLATE_BYTES = 10 * 1024 * 1024;

export class WorkspaceManager {
  constructor(private readonly root: string, private readonly templatesRoot = path.resolve("workspace-templates")) {}

  workspacePath(agentId: string): string {
    return this.pathForName(agentId);
  }

  pathForName(name: string): string {
    if (!NAME.test(name)) throw new Error("Invalid workspace name");
    const resolved = path.resolve(this.root, name);
    if (path.dirname(resolved) !== path.resolve(this.root)) throw new Error("Workspace must be directly under AGENT_WORKSPACE_ROOT");
    return resolved;
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, ".deleted"), { recursive: true });
  }

  private templatePath(name: string): string {
    if (!NAME.test(name)) throw new Error("Invalid workspace template name");
    const resolved = path.resolve(this.templatesRoot, name);
    if (path.dirname(resolved) !== path.resolve(this.templatesRoot)) throw new Error("Invalid workspace template name");
    return resolved;
  }

  private async templateSize(directory: string): Promise<{ files: number; bytes: number }> {
    let files = 0; let bytes = 0;
    const walk = async (current: string): Promise<void> => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error("Workspace templates cannot contain symbolic links");
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) await walk(full);
        else { const info = await stat(full); files++; bytes += info.size; if (files > MAX_TEMPLATE_FILES || bytes > MAX_TEMPLATE_BYTES) throw new Error("Workspace template exceeds copy limits"); }
      }
    };
    await walk(directory); return { files, bytes };
  }

  async listTemplates(): Promise<({ name: string; fileCount: number; bytes: number } | { name: string; error: string })[]> {
    let entries;
    try { entries = await readdir(this.templatesRoot, { withFileTypes: true }); } catch { return []; }
    const templates: ({ name: string; fileCount: number; bytes: number } | { name: string; error: string })[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !NAME.test(entry.name)) continue;
      // A symlink or over-limit template is reported per entry, never a 500 for the whole list (same shape as list()).
      try {
        const size = await this.templateSize(this.templatePath(entry.name));
        templates.push({ name: entry.name, fileCount: size.files, bytes: size.bytes });
      } catch (error) {
        templates.push({ name: entry.name, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return templates.sort((a, b) => a.name.localeCompare(b.name));
  }

  async create(agent: Agent, allowExisting = false, template?: string): Promise<void> {
    let exists = true;
    try { await stat(agent.workspacePath); } catch { exists = false; }
    if (exists && (!allowExisting || template)) throw new Error(template ? "A template requires a new workspace" : "Workspace already exists");
    if (!exists) await mkdir(agent.workspacePath, { recursive: false });
    if (!exists && template) {
      const source = this.templatePath(template);
      await this.templateSize(source);
      await cp(source, agent.workspacePath, { recursive: true, dereference: false, errorOnExist: false, force: false });
    }
    await this.writeInstructions(agent);
    if (exists) return;
    // AGENTS.md is platform-owned (written above); README.md/.gitignore are defaults a template may ship itself.
    const writeIfAbsent = (file: string, content: string) =>
      writeFile(file, content, { encoding: "utf8", flag: "wx" }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    await writeIfAbsent(
      path.join(agent.workspacePath, ".gitignore"),
      [".codex/", "node_modules/", "dist/", ".env", "*.log", ""].join("\n"),
    );
    await writeIfAbsent(
      path.join(agent.workspacePath, "README.md"),
      [
        "# " + agent.name + " workspace",
        "",
        "Files created or edited by the Agent live here.",
        "The platform-generated AGENTS.md contains the current Agent instructions.",
        "",
      ].join("\n"),
    );
  }

  async list(agents: Agent[]): Promise<{ name: string; path: string; agents: string[]; fileCount: number; lastModified: string; managed: boolean }[]> {
    const entries = await readdir(this.root, { withFileTypes: true });
    const output = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".deleted") continue;
      // Hand-seeded dirs with unattachable names (`My-Repo`, `.git`) and per-entry stat failures (EPERM, removed
      // mid-walk) are skipped, never a 500: the web calls this list on every bootstrap.
      let workspacePath: string;
      try { workspacePath = this.pathForName(entry.name); } catch { continue; }
      try {
        let fileCount = 0;
        let latest = (await stat(workspacePath)).mtimeMs;
        const walk = async (directory: string): Promise<void> => {
          for (const child of await readdir(directory, { withFileTypes: true })) {
            const childPath = path.join(directory, child.name);
            const info = await stat(childPath);
            latest = Math.max(latest, info.mtimeMs);
            if (child.isDirectory()) await walk(childPath);
            else fileCount++;
          }
        };
        await walk(workspacePath);
        const attached = agents.filter((agent) => path.resolve(agent.workspacePath) === workspacePath);
        output.push({
          name: entry.name,
          path: workspacePath,
          agents: attached.map((agent) => agent.id),
          fileCount,
          lastModified: new Date(latest).toISOString(),
          managed: attached.length === 1 && (attached[0]!.workspaceManaged ?? entry.name === attached[0]!.id),
        });
      } catch { continue; }
    }
    return output.sort((left, right) => left.name.localeCompare(right.name));
  }

  async writeInstructions(agent: Agent): Promise<void> {
    const content = [
      "# Platform-managed Agent instructions",
      "",
      "You are the coding Agent named " + agent.name + ".",
      agent.description ? "Purpose: " + agent.description : "",
      "",
      "## Instructions",
      "",
      agent.instructions ||
        "Help the user complete coding tasks in this workspace. Explain material results concisely.",
      "",
      "## Workspace rules",
      "",
      "- Work only inside this workspace unless the user explicitly requests otherwise.",
      "- Preserve existing user files and avoid destructive operations.",
      "- Build and test changes when practical.",
      "- Never print environment variables or credentials.",
      "",
      "This file is regenerated when the Agent configuration is updated.",
      "",
    ]
      .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
      .join("\n");
    await writeFile(path.join(agent.workspacePath, "AGENTS.md"), content, "utf8");
  }

  async archive(agent: Agent): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(
      this.root,
      ".deleted",
      agent.id + "-" + timestamp,
    );
    await rename(agent.workspacePath, destination);
    return destination;
  }
}
