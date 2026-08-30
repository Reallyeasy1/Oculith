import { describe, expect, it } from "vitest";
import { failClosed, redactEvent, redactText } from "./redact.js";
import { REDACTION_RULESET_VERSION, SCHEMA_VERSION, observationEventSchema, type ObservationEvent } from "./schema.js";

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
    ["bearer lowercase", "authorization: bearer " + BEARER_TOKEN, BEARER_TOKEN, "bearer"],
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
    for (const s of [
      "sk-short", "ark-not-a-uuid", "Bearer", "https://example.com/path", "KEY=1",
      "-----BEGIN CERTIFICATE-----", "AKLTshort",
    ]) {
      expect(redactText(s)).toEqual({ text: s, rules: [] });
    }
  });
  // #359 item 1: bare TOKEN=/SECRET=/KEY=/PASSWORD= (no prefix word) must redact. Pinned FP rule: a
  // value under 6 chars reads as a count/config and survives; 6+ redacts even when purely numeric.
  it.each([
    ["bare TOKEN", "TOKEN=" + ENV_VALUE, true],
    ["bare SECRET", "SECRET=" + ENV_VALUE, true],
    ["bare PASSWORD", "PASSWORD=hunter2hunter2", true],
    ["bare KEY", "KEY=" + ENV_VALUE, true],
    ["bare TOKEN numeric 6+ chars (pinned: could be a PIN/OTP — over-redact)", "TOKEN=123456", true],
    ["prefixed, as before", "GITHUB_TOKEN=" + ENV_VALUE, true],
    ["TOKENS=5 (plural + short numeric = a count)", "TOKENS=5", false],
    ["TOKEN=12345 (value under 6 chars = a count)", "TOKEN=12345", false],
    ["MAX_TOKENS=100000 (plural: word must end with the suffix)", "MAX_TOKENS=100000", false],
    ["TOKENS=abcdef123456 (plural even with a long value)", "TOKENS=abcdef123456", false],
  ])("env_assignment %s -> redacted=%s", (_n, input, redacts) => {
    const out = redactText(input);
    if (redacts) {
      expect(out.rules).toEqual(["env_assignment"]);
      expect(out.text).toBe("[REDACTED:env_assignment]");
    } else {
      expect(out).toEqual({ text: input, rules: [] });
    }
  });
  // #359 item 2: openai_key left boundary — the ONLY reduction-direction change in this ruleset, so
  // pin both sides hard: real keys stay caught in every realistic left context, and only a preceding
  // WORD char (a fragment like "ta|sk-") suppresses the match.
  it.each([
    ["start of string", OAI],
    ["after a space", "key is " + OAI],
    ["after a double quote", '"' + OAI + '"'],
    ["after a single quote", "'" + OAI + "'"],
    // lowercase key= so env_assignment can't also fire and swap the marker we assert on
    ["after =", "openai_api_key=" + OAI],
    ["inside JSON", '{"apiKey":"' + OAI + '","model":"m"}'],
    ["inside a URL path", "https://evil.example/exfil/" + OAI],
    ["inside a URL query", "https://evil.example/cb?key=" + OAI + "&x=1"],
    ["after a colon", "token:" + OAI],
    ["after an open paren", "(" + OAI + ")"],
    ["after a hyphen (non-word boundary still counts — more-redaction retained)", "wrapped-" + OAI],
  ])("openai_key still caught %s", (_n, input) => {
    const out = redactText(input);
    expect(out.rules).toContain("openai_key");
    expect(out.text).not.toContain(OAI.slice(-8));
    expect(out.text).toContain("[REDACTED:openai_key]");
  });
  it.each([
    ["task-management (review #47 example)", "task-management-dashboard-refresh-tool"],
    ["risk- prefix word", "risk-assessment-management-workflow-notes"],
    ["desk- prefix word", "desk-organizer-with-twenty-plus-chars"],
  ])("openai_key leaves hyphenated words alone: %s", (_n, input) => {
    expect(redactText(input)).toEqual({ text: input, rules: [] });
  });
  // #359 item 3: an unencoded "/" inside the password segment must not let the URL escape the rule.
  it("credential_url redacts a password containing an unencoded slash", () => {
    const out = redactText("connect postgres://user:pa/ss@db.internal/x failed");
    expect(out.rules).toContain("credential_url");
    expect(out.text).toBe("connect [REDACTED:credential_url] failed");
    expect(out.text).not.toContain("pa/ss");
  });
  it("credential_url still ignores ordinary host:port URLs (no userinfo)", () => {
    for (const s of ["http://localhost:3000/api", "https://example.com:8080/path?q=1"]) {
      expect(redactText(s)).toEqual({ text: s, rules: [] });
    }
  });
  it("applies extra patterns (seeded fixtures)", () => {
    expect(redactText("CANARY-SECRET-42 present", [/CANARY-SECRET-\d+/g]).text).toBe("[REDACTED:custom] present");
  });
  it("redacts a PEM body truncated before its END marker (output caps can cut it off)", () => {
    const out = redactText("-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQ");
    expect(out.rules).toContain("private_key");
    expect(out.text).toBe("[REDACTED:private_key]");
    expect(out.text).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQ");
  });
  it("bounds credential_url's tail so it doesn't swallow sibling JSON content", () => {
    const out = redactText('{"db":"postgres://u:p@h/x","runId":"r_42"}');
    expect(out.rules).toContain("credential_url");
    expect(out.text).toBe('{"db":"[REDACTED:credential_url]","runId":"r_42"}');
    expect(redactText("https://example.com/path")).toEqual({ text: "https://example.com/path", rules: [] });
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
  // Boundary-aware in both spellings: a prefixed sensitive word drops, a plural/suffixed one survives,
  // and camelCase is checked via its snake_cased form so "accessToken" can't slip past "access_token".
  it.each([
    ["access_token", true], ["x-api-key", true], ["total_tokens", false], ["input_tokens", false],
    ["accessToken", true], ["authToken", true], ["apiSecret", true], ["sessionCookie", true], ["xApiKey", true],
    ["inputTokens", false], ["cachedInputTokens", false], ["exitCode", false],
    ["secret_key", true], ["aws_secret_access_key", true], ["SecretKey", true], ["password_hash", true],
    ["http.request.header.authorization", true], ["tokens_total", false],
  ] as const)("denylist: %s dropped=%s", (key, dropped) => {
    const out = redactEvent(ev({ attributes: { [key]: 7 } }), { policy: "metadata_only" });
    expect(Object.hasOwn(out.attributes, key)).toBe(!dropped);
  });
  it("metadata_only strips summary entirely; safe_summary truncates and counts bytes", () => {
    const long = "x".repeat(5000);
    const meta = redactEvent(ev({ summary: { text: long, policy: "safe_summary" } }), { policy: "metadata_only" });
    expect(meta.summary).toBeUndefined();
    const safe = redactEvent(ev({ summary: { text: long, policy: "safe_summary" } }), { policy: "safe_summary", maxSummaryChars: 1000 });
    expect(safe.summary?.text.length).toBe(1000);
    expect(safe.privacy.originalBytes).toBe(5000);
    expect(safe.privacy.storedBytes).toBe(1000);
    // #359 item 5 (same ruling as shrinkToCap, #356): a size cap is a truncation, not a redaction —
    // reason records it, and redacted/rules stay false/absent when no rule actually fired.
    expect(safe.privacy.reason).toBe("summary_truncated");
    expect(safe.privacy.redacted).toBe(false);
    expect(safe.privacy.rules).toBeUndefined();
  });
  it("reasoning_summary keeps summaries exactly like safe_summary (superset tier, #259)", () => {
    const out = redactEvent(ev({ summary: { text: "plan: call Bearer " + BEARER_TOKEN, policy: "safe_summary" } }), { policy: "reasoning_summary" });
    expect(out.summary?.text).toContain("[REDACTED:bearer]");
    expect(out.summary?.text).not.toContain(BEARER_TOKEN);
    expect(out.privacy.rules).not.toContain("policy_drop_summary");
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
  it("failClosed keeps identifiers/timing/status and drops content without re-scanning name/sessionId", () => {
    const out = failClosed(ev({
      sessionId: "thr-" + FAKE_ARK, name: "run " + FAKE_ARK, durationMs: 42, status: "error",
      attributes: { command: "secret" }, summary: { text: "s", policy: "safe_summary" }, error: { type: "e", message: "m" },
    }));
    expect(out.attributes).toEqual({});
    expect(out.summary).toBeUndefined();
    expect(out.error).toEqual({ type: "e", message: "[REDACTED:failed_closed]" });
    expect(out.privacy).toMatchObject({ redacted: true, reason: "redaction_failed_closed" });
    expect(out.traceId).toBe("trc_1");
    expect(out.name).toBe(out.type);
    expect(out.sessionId).toBeUndefined();
    expect(out.durationMs).toBe(42);
    expect(out.status).toBe("error");
  });
  it("scans requestId (Fastify copies an inbound request-id header into it — untrusted like sessionId)", () => {
    const out = redactEvent(ev({ requestId: "req-" + FAKE_ARK }), { policy: "metadata_only" });
    expect(out.requestId).toContain("[REDACTED:ark_key]");
    expect(out.requestId).not.toContain("0f0f0f0f");
    expect(out.privacy.rules).toContain("ark_key");
  });
  it("clamps scanned bounded fields after substitution so a redacted event still passes the schema (#54)", () => {
    // A [REDACTED:…] marker is longer than most secrets; without a clamp the event is quarantined instead of stored.
    const longName = "x".repeat(110) + " " + FAKE_ARK;
    const out = redactEvent(
      ev({ name: longName, sessionId: "s".repeat(120) + " " + FAKE_ARK, attributes: { note: "y".repeat(2040) + " " + FAKE_ARK } }),
      { policy: "metadata_only" },
    );
    expect(out.name.length).toBeLessThanOrEqual(120);
    expect((out.sessionId ?? "").length).toBeLessThanOrEqual(128);
    expect(String(out.attributes.note).length).toBeLessThanOrEqual(2048);
    expect(observationEventSchema.safeParse(out).success).toBe(true);
  });
  it("stamps this pass's rulesetVersion and never carries the input's privacy block through", () => {
    const out = redactEvent(ev({ privacy: { redacted: true, rulesetVersion: "0", reason: "stale", rules: ["bogus"] } }), { policy: "metadata_only" });
    expect(out.privacy).toEqual({ redacted: false, rulesetVersion: REDACTION_RULESET_VERSION });
  });
  it("applies extraPatterns through redactEvent and reports them as the custom rule", () => {
    const out = redactEvent(ev({ attributes: { note: "CANARY-SECRET-42 present" } }), { policy: "metadata_only", extraPatterns: [/CANARY-SECRET-\d+/g] });
    expect(out.attributes.note).toBe("[REDACTED:custom] present");
    expect(out.privacy.rules).toEqual(["custom"]);
  });
  it("caps error messages at 2048 and summaries at the 4096 default", () => {
    const out = redactEvent(
      ev({ error: { type: "e", message: "m".repeat(3000) }, summary: { text: "s".repeat(5000), policy: "safe_summary" } }),
      { policy: "safe_summary" },
    );
    expect(out.error?.message.length).toBe(2048);
    expect(out.summary?.text.length).toBe(4096);
    expect(out.privacy.reason).toBe("summary_truncated");
    expect(out.privacy.redacted).toBe(false);
  });
  it("redacted summary that also hits the cap reports both: rule in rules, cap in reason", () => {
    const out = redactEvent(
      ev({ summary: { text: "Bearer " + BEARER_TOKEN + " " + "s".repeat(5000), policy: "safe_summary" } }),
      { policy: "safe_summary" },
    );
    expect(out.privacy.redacted).toBe(true);
    expect(out.privacy.rules).toEqual(["bearer"]);
    expect(out.privacy.reason).toBe("summary_truncated");
  });
  // #359 item 4: agentId/runId are server-generated, but scan them like requestId anyway —
  // defense-in-depth against a future adapter threading an outside value through.
  it("scans agentId and runId for key-shaped content", () => {
    const out = redactEvent(ev({ agentId: "agt-" + FAKE_ARK, runId: "run-" + FAKE_ARK }), { policy: "metadata_only" });
    expect(out.agentId).toContain("[REDACTED:ark_key]");
    expect(out.runId).toContain("[REDACTED:ark_key]");
    expect(out.agentId).not.toContain("0f0f0f0f");
    expect(out.runId).not.toContain("0f0f0f0f");
    expect(out.privacy.rules).toContain("ark_key");
    expect(out.privacy.redacted).toBe(true);
  });
  it("leaves clean agentId/runId untouched", () => {
    const out = redactEvent(ev({}), { policy: "metadata_only" });
    expect(out.agentId).toBe("a");
    expect(out.runId).toBe("r");
    expect(out.privacy.redacted).toBe(false);
  });
  it("failClosed drops requestId (header-copyable) but keeps the server-generated parentSpanId", () => {
    const out = failClosed(ev({ requestId: "req-x", parentSpanId: "spn_0" }));
    expect(out.requestId).toBeUndefined();
    expect(out.parentSpanId).toBe("spn_0");
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
