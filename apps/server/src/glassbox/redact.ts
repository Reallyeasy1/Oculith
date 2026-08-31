import { REDACTION_RULESET_VERSION, capturesSummaries, type CapturePolicy, type ObservationEvent } from "./schema.js";

export interface RedactOptions {
  policy: CapturePolicy;
  extraPatterns?: RegExp[] | undefined;
  maxSummaryChars?: number | undefined;
  /** Rules already applied before bounding a field. The trusted adapter supplies these when it must
   * redact before slicing, so the persisted privacy evidence remains truthful without retaining raw text. */
  preRedactedRules?: readonly string[] | undefined;
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
  // Left boundary (#359, review #47): a preceding LETTER means "sk-" is a fragment of a longer word
  // ("task-management-…" starts with "ta" + "sk-"), so only reject [A-Za-z] on the left — digits and
  // underscore still count as boundaries ("v2sk-…", "backup_sk-…" stay caught; privacy review #363). A preceding
  // hyphen or any punctuation still counts as a boundary, so keys glued after "-", "=", quotes, "/" (URLs)
  // or JSON syntax stay caught — this is the narrowest reduction that kills the hyphenated-word FP.
  ["openai_key", /(?<![A-Za-z])sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g],
  ["ark_key", /ark-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-[0-9a-f]+)?/gi],
  ["volc_ak", /AKLT[A-Za-z0-9]{20,}/g],
  // Matches the whole credentialed URL (scheme://user:pass@host/path), not just the userinfo — the host can be
  // sensitive too. Tail is bounded to quote/whitespace/angle-bracket delimiters so it doesn't swallow whatever
  // follows the URL inside JSON or markup (e.g. a sibling `"runId":"r_42"` key).
  // Password segment allows an unencoded "/" (#359: `scheme://user:pa/ss@host` must redact) — a strict
  // widening of the old [^\s/@] class. Known over-match (safe direction): in a whitespace-free run with no
  // "@" in the URL itself but one later (e.g. `…:8080/x?to=a@b`), the greedy password can reach that "@".
  ["credential_url", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s@]+@[^\s"'<>]*/gi],
  // Prefix word is optional (#359) so bare `TOKEN=…`/`SECRET=…` assignments are caught, not only
  // `OPENAI_API_KEY=…`. False-positive rule: the value must be 6+ non-space chars, so short numerics that
  // read as counts (`TOKENS=5`, `TOKEN=12345`) survive, while a 6+ char value redacts even when numeric —
  // a long digit string is plausibly a PIN/OTP, and over-redacting a count is the safe direction. Plurals
  // (`MAX_TOKENS=100000`) never match: the word must END with the sensitive suffix, right before "=".
  ["env_assignment", /\b(?:[A-Z][A-Z0-9_]*)?(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*\S{6,}/g],
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
  // Adapter provenance is trusted only as an indication that redaction already happened. Keep the
  // schema boundary here authoritative so a future adapter cannot quarantine safe evidence by
  // supplying an oversized/empty rule id or more entries than the persisted contract permits.
  const rules = new Set<string>(
    (options.preRedactedRules ?? []).filter((rule) => rule.length > 0 && rule.length <= 64).slice(0, 32),
  );
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
  // agentId/runId are server-generated today, but scan them anyway (#359, cheap defense-in-depth like
  // requestId): a future adapter could thread an outside value through, and ids render verbatim in the UI.
  const agentResult = redactText(event.agentId, extra);
  agentResult.rules.forEach((x) => rules.add(x));
  out.agentId = agentResult.text.slice(0, 128);
  const runResult = redactText(event.runId, extra);
  runResult.rules.forEach((x) => rules.add(x));
  out.runId = runResult.text.slice(0, 128);

  if (event.error) {
    const r = redactText(event.error.message, extra); r.rules.forEach((x) => rules.add(x));
    out.error = { type: event.error.type, message: r.text.slice(0, 2048) };
  }

  let originalBytes: number | undefined;
  let storedBytes: number | undefined;
  let summaryTruncated = false;
  if (event.summary) {
    if (!capturesSummaries(options.policy)) { delete out.summary; rules.add("policy_drop_summary"); }
    else {
      const max = options.maxSummaryChars ?? 4096;
      const r = redactText(event.summary.text, extra); r.rules.forEach((x) => rules.add(x));
      originalBytes = Buffer.byteLength(event.summary.text, "utf8");
      const text = r.text.length > max ? r.text.slice(0, max) : r.text;
      // A size cap is a truncation, not a redaction (#356, same ruling as store.ts shrinkToCap): record it
      // as `reason`, never in `rules`, so `redacted` / the UI badge only ever report genuine rule hits.
      if (text.length < r.text.length) summaryTruncated = true;
      out.summary = { text, policy: "safe_summary" };
      storedBytes = Buffer.byteLength(text, "utf8");
    }
  }

  // Strictly derived from this pass — never carries redacted/rules/reason through from the input event.
  out.privacy = {
    redacted: rules.size > 0,
    rulesetVersion: REDACTION_RULESET_VERSION,
    ...(rules.size > 0 ? { rules: [...rules] } : {}),
    ...(summaryTruncated ? { reason: "summary_truncated" } : {}),
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
