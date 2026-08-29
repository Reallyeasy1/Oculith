import { REDACTION_RULESET_VERSION, capturesSummaries, type CapturePolicy, type ObservationEvent } from "./schema.js";

export interface RedactOptions {
  policy: CapturePolicy;
  extraPatterns?: RegExp[] | undefined;
  maxSummaryChars?: number | undefined;
}

// Boundary-aware "contains": the sensitive word must sit between separators (or the key's ends), so
// "aws_secret_access_key" and "http.request.header.authorization" drop while "total_tokens"/"tokens_total"
// survive (plural is a different word).
const DENY_KEY = /(^|[_.\-])(authorization|api[_-]?key|token|secret|password|cookie|private[_-]?key)($|[_.\-])/i;

/** camelCase keys carry the same words without a separator, so the prefix alternation above can't see
 * the boundary ("accessToken" is one word to the regex). Testing the snake_cased form as well catches
 * them without loosening the rule: "inputTokens" still splits to "input_tokens" and survives (plural). */
const isDenied = (key: string): boolean =>
  DENY_KEY.test(key) || DENY_KEY.test(key.replace(/([a-z0-9])([A-Z])/g, "$1_$2"));

const PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  // No trailing "|$" alternative would miss a PEM body truncated before its END marker (e.g. by output caps);
  // falling back to end-of-string keeps the body from shipping in cleartext.
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ["bearer", /Bearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi],
  ["openai_key", /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g],
  ["ark_key", /ark-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-[0-9a-f]+)?/gi],
  ["volc_ak", /AKLT[A-Za-z0-9]{20,}/g],
  // Matches the whole credentialed URL (scheme://user:pass@host/path), not just the userinfo — the host can be
  // sensitive too. Tail is bounded to quote/whitespace/angle-bracket delimiters so it doesn't swallow whatever
  // follows the URL inside JSON or markup (e.g. a sibling `"runId":"r_42"` key).
  ["credential_url", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@[^\s"'<>]*/gi],
  ["env_assignment", /\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*\S{6,}/g],
  // ponytail: no volc_sk rule — Volcengine SKs are unanchored base64 (a pattern would false-positive on
  // ordinary output); add one when a real shape appears. A key split across attribute values stays a known ceiling.
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
    if (isDenied(key)) { rules.add("denylist_key"); continue; }
    if (typeof value === "string") {
      // Clamps after substitution (here and on name/sessionId/requestId below): a [REDACTED:…] marker can be
      // longer than the secret it replaced, and an over-bound field would quarantine the event instead of storing it (#54).
      const r = redactText(value, extra); r.rules.forEach((x) => rules.add(x)); attributes[key] = r.text.slice(0, 2048);
    } else attributes[key] = value;
  }
  const out: ObservationEvent = { ...event, attributes };

  // Controller ruling: a runner thread id or span name can carry a key, so scan these string fields too.
  // requestId is untrusted for the same reason — Fastify copies an inbound `request-id` header into it.
  // parentSpanId stays unscanned: it is always a server-generated newId, never copied from outside.
  const nameResult = redactText(event.name, extra);
  nameResult.rules.forEach((x) => rules.add(x));
  out.name = nameResult.text.slice(0, 120);
  if (event.sessionId !== undefined) {
    const sessionResult = redactText(event.sessionId, extra);
    sessionResult.rules.forEach((x) => rules.add(x));
    out.sessionId = sessionResult.text.slice(0, 128);
  }
  if (event.requestId !== undefined) {
    const requestResult = redactText(event.requestId, extra);
    requestResult.rules.forEach((x) => rules.add(x));
    out.requestId = requestResult.text.slice(0, 128);
  }

  if (event.error) {
    const r = redactText(event.error.message, extra); r.rules.forEach((x) => rules.add(x));
    out.error = { type: event.error.type, message: r.text.slice(0, 2048) };
  }

  let originalBytes: number | undefined;
  let storedBytes: number | undefined;
  if (event.summary) {
    if (!capturesSummaries(options.policy)) { delete out.summary; rules.add("policy_drop_summary"); }
    else {
      const max = options.maxSummaryChars ?? 4096;
      const r = redactText(event.summary.text, extra); r.rules.forEach((x) => rules.add(x));
      originalBytes = Buffer.byteLength(event.summary.text, "utf8");
      const text = r.text.length > max ? r.text.slice(0, max) : r.text;
      if (text.length < r.text.length) rules.add("truncated");
      out.summary = { text, policy: "safe_summary" };
      storedBytes = Buffer.byteLength(text, "utf8");
    }
  }

  // Strictly derived from this pass — never carries redacted/rules/reason through from the input event.
  out.privacy = {
    redacted: rules.size > 0,
    rulesetVersion: REDACTION_RULESET_VERSION,
    ...(rules.size > 0 ? { rules: [...rules] } : {}),
    ...(originalBytes !== undefined ? { originalBytes } : {}),
    ...(storedBytes !== undefined ? { storedBytes } : {}),
  };
  return out;
}

/** Used by the emitter when redactEvent throws: keep identifiers/timing/status, drop all content.
 * Does not re-invoke the scanner (that already failed) — name/sessionId are replaced/dropped outright
 * rather than scanned, since a value that broke the redactor once shouldn't be trusted a second time. */
export function failClosed(event: ObservationEvent): ObservationEvent {
  const out: ObservationEvent = {
    ...event, attributes: {}, name: event.type,
    privacy: { redacted: true, rulesetVersion: REDACTION_RULESET_VERSION, reason: "redaction_failed_closed" },
  };
  delete out.summary;
  delete out.sessionId;
  // requestId can be copied from an inbound `request-id` header — untrusted, so dropped like sessionId.
  // parentSpanId is always a server-generated newId and is kept so the span tree survives.
  delete out.requestId;
  if (event.error) out.error = { type: event.error.type, message: "[REDACTED:failed_closed]" };
  return out;
}
