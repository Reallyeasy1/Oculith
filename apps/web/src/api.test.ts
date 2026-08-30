import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, humanizeErrorMessage } from "./api";

afterEach(() => vi.unstubAllGlobals());

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
