import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JsonStore } from "./store.js";

describe("JsonStore", () => {
  it("refuses to write before initialize() so a boot-order slip cannot wipe the file", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "launchpad-json-")), "launchpad.json");
    await writeFile(file, JSON.stringify({ version: 1, agents: [{ id: "a" }], runs: [], messages: [] }), "utf8");
    const store = new JsonStore(file);
    await expect(store.mutate((db) => db.agents.push({ id: "b" } as never))).rejects.toThrow("before initialize()");
    expect(JSON.parse(await readFile(file, "utf8")).agents).toHaveLength(1);
    await store.initialize();
    await store.mutate((db) => db.agents.push({ id: "b" } as never));
    expect(JSON.parse(await readFile(file, "utf8")).agents).toHaveLength(2);
  });
});
