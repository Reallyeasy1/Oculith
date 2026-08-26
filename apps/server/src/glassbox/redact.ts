import { REDACTION_RULESET_VERSION, type CapturePolicy, type ObservationEvent } from "./schema.js";

export interface RedactOptions {
  policy: CapturePolicy;
  extraPatterns?: RegExp[] | undefined;
  maxSummaryChars?: number | undefined;
}

const DENY_KEY = /^(authorization|api[_-]?key|token|secret|password|cookie|private[_-]?key)$/i;

const PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ["bearer", /Bearer\s+[A-Za-z0-9._~+/-]{16,}=*/g],
  ["openai_key", /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g],
  ["ark_key", /ark-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-[0-9a-f]+)?/g],
  ["volc_ak", /AKLT[A-Za-z0-9]{20,}/g],
  // Matches the whole credentialed URL (scheme://user:pass@host/path), not just the userinfo — the host can be sensitive too.
  ["credential_url", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@\S*/gi],
  ["env_assignment", /\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*\S{6,}/g],
];

export function redactText(text: string, extra: RegExp[] = []): { text: string; rules: string[] } {
  const rules = new Set<string>();
  let out = text;
  for (const [rule, re] of PATTERNS) {
    if (re.test(out)) { rules.add(rule); out = out.replace(re, "[REDACTED:" + rule + "]"); }
    re.lastIndex = 0;
  }
  for (const re of extra) {
    const g = re.global ? re : new RegExp(re.source, re.flags + "g");
    if (g.test(out)) { rules.add("custom"); out = out.replace(g, "[REDACTED:custom]"); }
    g.lastIndex = 0;
  }
  return { text: out, rules: [...rules] };
}

export function redactEvent(event: ObservationEvent, options: RedactOptions): ObservationEvent {
  const rules = new Set<string>();
  const extra = options.extraPatterns ?? [];
  const attributes: ObservationEvent["attributes"] = {};
  for (const [key, value] of Object.entries(event.attributes)) {
    if (DENY_KEY.test(key)) { rules.add("denylist_key"); continue; }
    if (typeof value === "string") {
      const r = redactText(value, extra); r.rules.forEach((x) => rules.add(x)); attributes[key] = r.text;
    } else attributes[key] = value;
  }
  const out: ObservationEvent = { ...event, attributes, privacy: { ...event.privacy, rulesetVersion: REDACTION_RULESET_VERSION } };

  // Controller ruling: a runner thread id or span name can carry a key, so scan these string fields too.
  const nameResult = redactText(event.name, extra);
  nameResult.rules.forEach((x) => rules.add(x));
  out.name = nameResult.text;
  if (event.sessionId !== undefined) {
    const sessionResult = redactText(event.sessionId, extra);
    sessionResult.rules.forEach((x) => rules.add(x));
    out.sessionId = sessionResult.text;
  }

  if (event.error) {
    const r = redactText(event.error.message, extra); r.rules.forEach((x) => rules.add(x));
    out.error = { type: event.error.type, message: r.text.slice(0, 2048) };
  }
  if (event.summary) {
    if (options.policy !== "safe_summary") { delete out.summary; rules.add("policy_drop_summary"); }
    else {
      const max = options.maxSummaryChars ?? 4096;
      const r = redactText(event.summary.text, extra); r.rules.forEach((x) => rules.add(x));
      const original = Buffer.byteLength(event.summary.text, "utf8");
      const text = r.text.length > max ? r.text.slice(0, max) : r.text;
      if (text.length < r.text.length) rules.add("truncated");
      out.summary = { text, policy: "safe_summary" };
      out.privacy = { ...out.privacy, originalBytes: original, storedBytes: Buffer.byteLength(text, "utf8") };
    }
  }
  if (rules.size > 0) out.privacy = { ...out.privacy, redacted: true, rules: [...rules] };
  return out;
}

/** Used by the emitter when redactEvent throws: keep identifiers/timing/status, drop all content. */
export function failClosed(event: ObservationEvent): ObservationEvent {
  const out: ObservationEvent = {
    ...event, attributes: {},
    privacy: { redacted: true, rulesetVersion: REDACTION_RULESET_VERSION, reason: "redaction_failed_closed" },
  };
  delete out.summary;
  if (event.error) out.error = { type: event.error.type, message: "[REDACTED:failed_closed]" };
  return out;
}
