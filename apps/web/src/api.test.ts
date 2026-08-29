import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

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
