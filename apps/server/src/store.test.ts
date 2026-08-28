import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore, renameWithRetry } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JsonStore", () => {
  it("does not publish a mutation in memory when persistence fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const originalPath = path.join(root, "db.json");
    const store = new JsonStore(originalPath);
    await store.initialize();

    const mutableStore = store as unknown as { filePath: string };
    mutableStore.filePath = path.join(root, "missing-directory", "db.json");
    await expect(
      store.mutate((database) => {
        database.messages.push({
          id: "message-1",
          agentId: "agent-1",
          runId: "run-1",
          role: "user",
          content: "must not become visible",
          createdAt: new Date().toISOString(),
        });
      }),
    ).rejects.toThrow();
    expect(store.snapshot().messages).toEqual([]);

    mutableStore.filePath = originalPath;
    await store.mutate((database) => {
      database.messages.push({
        id: "message-2",
        agentId: "agent-1",
        runId: "run-2",
        role: "user",
        content: "queue recovered",
        createdAt: new Date().toISOString(),
      });
    });
    expect(store.snapshot().messages.map((message) => message.content)).toEqual([
      "queue recovered",
    ]);
  });
});

describe("renameWithRetry (#274)", () => {
  const eperm = () => Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });

  it("absorbs transient EPERM/EBUSY locks and succeeds on a later attempt", async () => {
    let calls = 0;
    await renameWithRetry("a.tmp", "a", async () => {
      calls++;
      if (calls < 3) throw eperm();
    });
    expect(calls).toBe(3);
  });

  it("gives up after the bounded retries", async () => {
    let calls = 0;
    await expect(renameWithRetry("a.tmp", "a", async () => { calls++; throw eperm(); })).rejects.toThrow("EPERM");
    expect(calls).toBe(4);
  });

  it("surfaces non-lock errors immediately", async () => {
    let calls = 0;
    const enoent = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    await expect(renameWithRetry("a.tmp", "a", async () => { calls++; throw enoent; })).rejects.toThrow("ENOENT");
    expect(calls).toBe(1);
  });
});
