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
});
