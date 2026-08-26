import { describe, expect, it } from "vitest";
import { failClosed, redactEvent, redactText } from "./redact.js";
import { SCHEMA_VERSION, type ObservationEvent } from "./schema.js";

// Built at runtime so no key-shaped literal is ever committed (GitHub push protection scans file contents).
const FAKE_ARK = ["ark", "0f0f0f0f", "1a1a", "4b4b", "8c8c", "d0d0d0d0d0d0", "0abc1"].join("-");
const OAI = "sk-proj-" + "abcdefghijklmnopqrstuvwxyz0123456789";
const BEARER_TOKEN = "abcdefghijklmnopqrstuvwxyz.123456";
const VOLC_AK = "AKLT" + "abcdefghijklmnopqrstuvwxyz12";
const ENV_VALUE = "abc123def456";
const ev = (over: Partial<ObservationEvent>): ObservationEvent => ({
  schemaVersion: SCHEMA_VERSION, eventId: "evt_1", sequence: 1, traceId: "trc_1", spanId: "spn_1",
  runId: "r", agentId: "a", actorId: "local-user", actorType: "human", attempt: 1,
  timestamp: "2026-08-26T00:00:00.000Z", type: "tool.call.completed", category: "tool", phase: "instant",
  status: "ok", name: "shell", source: { component: "AgentRunner", observed: true }, attributes: {},
  privacy: { redacted: false, rulesetVersion: "1" }, ...over,
});

describe("redactText", () => {
  it.each([
    ["openai key", "token " + OAI + " here", OAI, "openai_key"],
    ["ark key", "ARK " + FAKE_ARK, FAKE_ARK, "ark_key"],
    ["bearer", "Authorization: Bearer " + BEARER_TOKEN, BEARER_TOKEN, "bearer"],
    ["volc ak", VOLC_AK, VOLC_AK, "volc_ak"],
    ["private key", "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----", "MIIE", "private_key"],
    ["credential url", "postgres://user:hunter2@db.internal/x", "hunter2", "credential_url"],
    ["env assignment", "OPENAI_API_KEY=" + ENV_VALUE, ENV_VALUE, "env_assignment"],
  ])("redacts %s", (_n, input, secret, rule) => {
    const out = redactText(input);
    expect(out.rules).toContain(rule);
    expect(out.text).not.toContain(secret.slice(-8));
    expect(out.text).toContain("[REDACTED:" + rule + "]");
  });
  it("leaves near misses alone", () => {
    for (const s of ["sk-short", "ark-not-a-uuid", "Bearer", "https://example.com/path", "KEY=1"]) {
      expect(redactText(s)).toEqual({ text: s, rules: [] });
    }
  });
  it("applies extra patterns (seeded fixtures)", () => {
    expect(redactText("CANARY-SECRET-42 present", [/CANARY-SECRET-\d+/g]).text).toBe("[REDACTED:custom] present");
  });
});

describe("redactEvent", () => {
  it("drops denylisted keys case-insensitively and scans remaining strings", () => {
    const out = redactEvent(ev({ attributes: { Authorization: "x", api_key: "y", command: "curl -H 'Bearer abcdefghijklmnopqrstuvwxyz' u", exitCode: 0 } }), { policy: "safe_summary" });
    expect(out.attributes).not.toHaveProperty("Authorization");
    expect(out.attributes).not.toHaveProperty("api_key");
    expect(out.attributes.command).toContain("[REDACTED:bearer]");
    expect(out.attributes.exitCode).toBe(0);
    expect(out.privacy.redacted).toBe(true);
    expect(out.privacy.rules).toEqual(expect.arrayContaining(["denylist_key", "bearer"]));
  });
  it("metadata_only strips summary entirely; safe_summary truncates and counts bytes", () => {
    const long = "x".repeat(5000);
    const meta = redactEvent(ev({ summary: { text: long, policy: "safe_summary" } }), { policy: "metadata_only" });
    expect(meta.summary).toBeUndefined();
    const safe = redactEvent(ev({ summary: { text: long, policy: "safe_summary" } }), { policy: "safe_summary", maxSummaryChars: 1000 });
    expect(safe.summary?.text.length).toBe(1000);
    expect(safe.privacy.originalBytes).toBe(5000);
    expect(safe.privacy.storedBytes).toBe(1000);
    expect(safe.privacy.rules).toContain("truncated");
  });
  it("scans error messages under every policy", () => {
    const out = redactEvent(ev({ error: { type: "exit", message: "failed with " + FAKE_ARK } }), { policy: "metadata_only" });
    expect(out.error?.message).not.toContain("0f0f0f0f");
  });
  it("is pure", () => {
    const input = ev({ attributes: { token: "t" } });
    redactEvent(input, { policy: "metadata_only" });
    expect(input.attributes.token).toBe("t");
  });
  it("failClosed keeps identifiers and drops content", () => {
    const out = failClosed(ev({ attributes: { command: "secret" }, summary: { text: "s", policy: "safe_summary" }, error: { type: "e", message: "m" } }));
    expect(out.attributes).toEqual({});
    expect(out.summary).toBeUndefined();
    expect(out.error).toEqual({ type: "e", message: "[REDACTED:failed_closed]" });
    expect(out.privacy).toMatchObject({ redacted: true, reason: "redaction_failed_closed" });
    expect(out.traceId).toBe("trc_1");
  });
  it("scans name and sessionId for key-shaped content (a runner thread id or span name can carry a key)", () => {
    const out = redactEvent(ev({ sessionId: "thr-" + FAKE_ARK, name: "run " + FAKE_ARK }), { policy: "metadata_only" });
    expect(out.sessionId).toContain("[REDACTED:ark_key]");
    expect(out.name).toContain("[REDACTED:ark_key]");
    expect(out.sessionId).not.toContain("0f0f0f0f");
    expect(out.name).not.toContain("0f0f0f0f");
    expect(out.privacy.rules).toContain("ark_key");
  });
});
