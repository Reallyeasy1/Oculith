import { mkdir, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent } from "./types.js";

export class WorkspaceManager {
  constructor(private readonly root: string) {}

  workspacePath(agentId: string): string {
    return this.pathForName(agentId);
  }

  pathForName(name: string): string {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) throw new Error("Invalid workspace name");
    const resolved = path.resolve(this.root, name);
    if (path.dirname(resolved) !== path.resolve(this.root)) throw new Error("Workspace must be directly under AGENT_WORKSPACE_ROOT");
    return resolved;
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, ".deleted"), { recursive: true });
  }

  async create(agent: Agent, allowExisting = false): Promise<void> {
    let exists = true;
    try { await stat(agent.workspacePath); } catch { exists = false; }
    if (exists && !allowExisting) throw new Error("Workspace already exists");
    if (!exists) await mkdir(agent.workspacePath, { recursive: false });
    await this.writeInstructions(agent);
    if (exists) return;
    await writeFile(
      path.join(agent.workspacePath, ".gitignore"),
      [".codex/", "node_modules/", "dist/", ".env", "*.log", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(agent.workspacePath, "README.md"),
      [
        "# " + agent.name + " workspace",
        "",
        "Files created or edited by the Agent live here.",
        "The platform-generated AGENTS.md contains the current Agent instructions.",
        "",
      ].join("\n"),
      "utf8",
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
      "- You run in a disposable container: no process you start survives this turn and no port is reachable from the user's machine. Never tell the user to open a localhost URL you started.",
      "- For anything runnable, leave build output in the workspace (e.g. `dist/`) and state the exact command the user runs on their own machine.",
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
