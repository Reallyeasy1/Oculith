import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, clearAuthToken, filenameFromContentDisposition, getAuthToken, humanizeErrorMessage, probeToken, setAuthToken, setUnauthorizedHandler } from "./api";

afterEach(() => {
  setUnauthorizedHandler(null);
  clearAuthToken();
  vi.unstubAllGlobals();
});

/** Minimal Storage double — vitest runs in node, where sessionStorage does not exist. */
function fakeSessionStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    get size() {
      return map.size;
    },
  };
}

const jsonResponse = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("auth token persistence (#413)", () => {
  it("stores the trimmed token in sessionStorage and removes it when cleared", () => {
    const storage = fakeSessionStorage();
    vi.stubGlobal("sessionStorage", storage);

    setAuthToken("  shared-demo-token  ");
    expect(getAuthToken()).toBe("shared-demo-token");
    expect(storage.getItem("launchpad.access-token")).toBe("shared-demo-token");

    clearAuthToken();
    expect(getAuthToken()).toBe("");
    expect(storage.size).toBe(0);
  });

  it("restores the stored token when the module loads (refresh survival)", async () => {
    vi.stubGlobal("sessionStorage", fakeSessionStorage({ "launchpad.access-token": "restored-token" }));
    vi.resetModules();
    const fresh = await import("./api");
    expect(fresh.getAuthToken()).toBe("restored-token");
  });

  it("still works when sessionStorage is missing or throws", () => {
    setAuthToken("memory-only"); // node env: no sessionStorage global at all
    expect(getAuthToken()).toBe("memory-only");

    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    setAuthToken("still-memory");
    expect(getAuthToken()).toBe("still-memory");
  });

  it("wipes the stored token and notifies the handler on a 401", async () => {
    const storage = fakeSessionStorage();
    vi.stubGlobal("sessionStorage", storage);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { error: "unauthorized" })));
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    setAuthToken("rotated-away");

    await expect(api.listAgents()).rejects.toThrowError(new ApiError("unauthorized", 401));
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(getAuthToken()).toBe("");
    expect(storage.size).toBe(0);
  });

  it("ignores a 401 earned by a superseded token (slow response landing after re-auth)", async () => {
    const storage = fakeSessionStorage();
    vi.stubGlobal("sessionStorage", storage);
    let respond!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { respond = resolve; })));
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    setAuthToken("rotated-away");

    const pending = api.listAgents();
    setAuthToken("fresh-token"); // user re-authenticated while the request was in flight
    respond(jsonResponse(401, { error: "unauthorized" }));

    await expect(pending).rejects.toThrowError(new ApiError("unauthorized", 401));
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(getAuthToken()).toBe("fresh-token");
    expect(storage.getItem("launchpad.access-token")).toBe("fresh-token");
  });

  it("does not treat an anonymous 401 as a rejection of the current token", async () => {
    // A recovery request issued after the token was wiped goes out with no Authorization header;
    // its inevitable 401 must not re-fire the handler behind the token screen.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { error: "unauthorized" })));
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    clearAuthToken();

    await expect(api.listAgents()).rejects.toThrowError(new ApiError("unauthorized", 401));
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("keeps the token and stays quiet on non-401 failures", async () => {
    const storage = fakeSessionStorage();
    vi.stubGlobal("sessionStorage", storage);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(400, { error: "bad request" })));
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    setAuthToken("valid-token");

    await expect(api.listAgents()).rejects.toThrowError(new ApiError("bad request", 400));
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(getAuthToken()).toBe("valid-token");
    expect(storage.getItem("launchpad.access-token")).toBe("valid-token");
  });

  it("probeToken validates a candidate without persisting it or firing the handler", async () => {
    const storage = fakeSessionStorage({ "launchpad.access-token": "still-good" });
    vi.stubGlobal("sessionStorage", storage);
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    setAuthToken("still-good");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200)));
    await expect(probeToken("candidate")).resolves.toBe(true);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { error: "unauthorized" })));
    await expect(probeToken("wrong-guess")).resolves.toBe(false);
    // The rejected CANDIDATE must not disturb the working token or bounce the UI.
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(getAuthToken()).toBe("still-good");
    expect(storage.getItem("launchpad.access-token")).toBe("still-good");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(503, { error: "backend down" })));
    await expect(probeToken("candidate")).rejects.toThrowError(new ApiError("backend down", 503));
  });

  it("sends the trimmed candidate in probeToken's Authorization header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200));
    vi.stubGlobal("fetch", fetchMock);
    await probeToken("  padded-token  ");
    expect(fetchMock).toHaveBeenCalledWith("/api/system", {
      headers: { Authorization: "Bearer padded-token" },
    });
  });

  it("treats a 401 from the raw-fetch export path the same way", async () => {
    const storage = fakeSessionStorage();
    vi.stubGlobal("sessionStorage", storage);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { error: "unauthorized" })));
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    setAuthToken("rotated-away");

    await expect(api.exportTrace("trace-1")).rejects.toThrowError(new ApiError("unauthorized", 401));
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(getAuthToken()).toBe("");
    expect(storage.size).toBe(0);
  });
});

describe("evaluation API", () => {
  it("sends the explicit force flag when the user accepts a template mismatch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ evalRun: {} }), {
      status: 201,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const body = { agentId: "agent-1", caseIds: ["case-1"], force: true };
    await api.startEvalRun(body);

    expect(fetchMock).toHaveBeenCalledWith("/api/eval-runs", expect.objectContaining({
      method: "POST",
      body: JSON.stringify(body),
    }));
  });

  it("encodes the historical config comparison and optional time window (#174)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ a: {}, b: {}, deltas: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await api.compareReliability("agent/one", "cfg a", "cfg&b", {
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-31T23:59:59.999Z",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/reliability/compare?agentId=agent%2Fone&a=cfg+a&b=cfg%26b&from=2026-08-01T00%3A00%3A00.000Z&to=2026-08-31T23%3A59%3A59.999Z",
      expect.any(Object),
    );
  });
});

describe("humanizeErrorMessage (#344)", () => {
  const issue = (path: (string | number)[], message: string) => ({
    origin: "string",
    code: "too_small",
    minimum: 1,
    inclusive: true,
    path,
    message,
  });

  it("renders the first zod issue as 'path: message'", () => {
    expect(humanizeErrorMessage(JSON.stringify([issue(["name"], "Too small: expected string to have >=1 characters")])))
      .toBe("name: Too small: expected string to have >=1 characters");
  });

  it("joins nested paths with dots and counts the remaining issues", () => {
    const raw = JSON.stringify([
      issue(["budget", "maxRuns"], "Expected number"),
      issue(["name"], "Too small"),
      issue([], "Unrecognized key"),
    ]);
    expect(humanizeErrorMessage(raw)).toBe("budget.maxRuns: Expected number (+2 more)");
  });

  it("drops the path prefix when the issue has an empty path", () => {
    expect(humanizeErrorMessage(JSON.stringify([issue([], "Invalid input")]))).toBe("Invalid input");
  });

  it.each([
    ["a plain message", "Workspace is busy"],
    ["bracketed prose that is not JSON", "[server] mkdir failed"],
    ["a JSON array of strings", JSON.stringify(["not", "issues"])],
    ["an empty JSON array", "[]"],
    ["an array of objects without message/path", JSON.stringify([{ code: "x" }])],
  ])("passes %s through unchanged", (_label, message) => {
    expect(humanizeErrorMessage(message)).toBe(message);
  });

  it("applies to the error body ApiError carries out of request()", async () => {
    const body = { error: JSON.stringify([issue(["name"], "Too small")]) };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), {
      status: 400,
      headers: { "content-type": "application/json" },
    })));
    await expect(api.listAgents()).rejects.toThrowError(new ApiError("name: Too small", 400));
  });
});

describe("workspace downloads (#437)", () => {
  it.each([
    ["both forms, preferring the RFC 5987 one", "attachment; filename=\"r_sum_.zip\"; filename*=UTF-8''r%C3%A9sum%C3%A9.zip", "résumé.zip"],
    ["a plain quoted filename", 'attachment; filename="notes.txt"', "notes.txt"],
    ["an undecodable RFC 5987 value falling back to the quoted form", "attachment; filename=\"a.zip\"; filename*=UTF-8''%E0%A4%A", "a.zip"],
  ])("parses %s", (_label, header, expected) => {
    expect(filenameFromContentDisposition(header)).toBe(expected);
  });

  it.each([
    ["a missing header", null],
    ["a header with neither form", "attachment"],
    ["an empty quoted filename", 'attachment; filename=""'],
  ])("returns null for %s", (_label, header) => {
    expect(filenameFromContentDisposition(header)).toBe(null);
  });

  it("carries the token, reads the blob, and names the file from the header", async () => {
    setAuthToken("token-123");
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Blob([Buffer.from([1, 2, 3])]), {
      status: 200,
      headers: { "content-disposition": 'attachment; filename="ws.zip"' },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { blob, filename } = await api.downloadWorkspacePath("agent-1", "");
    expect(filename).toBe("ws.zip");
    expect(blob.size).toBe(3);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agents/agent-1/workspace/download?path=",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer token-123" }) }),
    );
  });

  it("falls back to the path basename when the header is absent, and maps error bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["x"]), { status: 200 })));
    expect((await api.downloadWorkspacePath("agent-1", "src/notes.txt")).filename).toBe("notes.txt");
    expect((await api.downloadWorkspacePath("agent-1", "")).filename).toBe("workspace.zip");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Archive exceeds the 128 MB limit" }), { status: 413 })));
    await expect(api.downloadWorkspacePath("agent-1", "")).rejects.toThrowError(
      new ApiError("Archive exceeds the 128 MB limit", 413),
    );
  });
});
