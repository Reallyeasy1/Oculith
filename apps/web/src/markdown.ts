// Minimal GFM-subset parser for assistant replies (#378). No dependencies by design
// (.claude/rules/web.md); safety comes from the renderer emitting React elements only,
// so anything this parser leaves as "text" can never become live HTML.

export type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: InlineToken[] }
  | { kind: "em"; children: InlineToken[] }
  | { kind: "del"; children: InlineToken[] }
  | { kind: "link"; href: string; children: InlineToken[] };

export type MarkdownBlock =
  | { kind: "heading"; level: number; children: InlineToken[] }
  | { kind: "paragraph"; lines: InlineToken[][] }
  | { kind: "code"; language: string; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: MarkdownBlock[][] }
  | { kind: "blockquote"; children: MarkdownBlock[] }
  | { kind: "hr" };

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BLOCKQUOTE = /^ {0,3}>/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/;

export function parseMarkdown(source: string): MarkdownBlock[] {
  return parseBlockLines(source.replace(/\r\n/g, "\n").split("\n"));
}

function parseBlockLines(lines: string[]): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const fence = line.match(FENCE_OPEN);
    if (fence) {
      const marker = fence[1] ?? "```";
      const language = (fence[2] ?? "").trim().split(/\s+/)[0] ?? "";
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        const close = (lines[i] ?? "").match(/^ {0,3}(`{3,}|~{3,})\s*$/);
        if (close && (close[1] ?? "").startsWith(marker[0] ?? "`") && (close[1] ?? "").length >= marker.length) {
          i += 1;
          break;
        }
        body.push(lines[i] ?? "");
        i += 1;
      }
      blocks.push({ kind: "code", language, text: body.join("\n") });
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      const text = (heading[2] ?? "").replace(/\s+#+\s*$/, "").trim();
      blocks.push({ kind: "heading", level: (heading[1] ?? "#").length, children: parseInline(text) });
      i += 1;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ kind: "hr" });
      i += 1;
      continue;
    }

    if (BLOCKQUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && BLOCKQUOTE.test(lines[i] ?? "")) {
        quoted.push((lines[i] ?? "").replace(/^ {0,3}> ?/, ""));
        i += 1;
      }
      blocks.push({ kind: "blockquote", children: parseBlockLines(quoted) });
      continue;
    }

    const item = line.match(LIST_ITEM);
    if (item) {
      const baseIndent = (item[1] ?? "").length;
      const ordered = /^\d/.test(item[2] ?? "");
      const start = ordered ? Number.parseInt(item[2] ?? "1", 10) : 1;
      const items: MarkdownBlock[][] = [];
      while (i < lines.length) {
        const m = (lines[i] ?? "").match(LIST_ITEM);
        if (!m || (m[1] ?? "").length !== baseIndent || /^\d/.test(m[2] ?? "") !== ordered) break;
        const contentIndent = baseIndent + (m[2] ?? "").length + (m[3] ?? " ").length;
        const itemLines: string[] = [m[4] ?? ""];
        i += 1;
        while (i < lines.length) {
          const next = lines[i] ?? "";
          if (next.trim() === "") {
            const ahead = nextNonBlank(lines, i + 1);
            if (ahead === null || leadingSpaces(lines[ahead] ?? "") <= baseIndent) break;
            itemLines.push("");
            i += 1;
            continue;
          }
          const indent = leadingSpaces(next);
          if (indent <= baseIndent) break;
          itemLines.push(next.slice(Math.min(indent, contentIndent)));
          i += 1;
        }
        items.push(parseBlockLines(itemLines));
        // Blank lines between siblings keep it one list.
        while (i < lines.length && (lines[i] ?? "").trim() === "") {
          const ahead = nextNonBlank(lines, i);
          if (ahead === null) break;
          const sibling = (lines[ahead] ?? "").match(LIST_ITEM);
          if (!sibling || (sibling[1] ?? "").length !== baseIndent) break;
          i += 1;
        }
      }
      blocks.push({ kind: "list", ordered, start: Number.isNaN(start) ? 1 : start, items });
      continue;
    }

    const paragraph: InlineToken[][] = [];
    while (i < lines.length) {
      const current = lines[i] ?? "";
      if (current.trim() === "") break;
      if (FENCE_OPEN.test(current) || HEADING.test(current) || HR.test(current) || BLOCKQUOTE.test(current) || LIST_ITEM.test(current)) break;
      paragraph.push(parseInline(current.trim()));
      i += 1;
    }
    blocks.push({ kind: "paragraph", lines: paragraph });
  }
  return blocks;
}

function nextNonBlank(lines: string[], from: number): number | null {
  for (let j = from; j < lines.length; j += 1) {
    if ((lines[j] ?? "").trim() !== "") return j;
  }
  return null;
}

function leadingSpaces(line: string): number {
  return line.length - line.trimStart().length;
}

const SAFE_HREF = /^(https?:|mailto:)/i;

type InlineMatcher = { re: RegExp; build: (m: RegExpExecArray) => InlineToken[] };

// Priority order: earliest match wins; on a tie the earlier matcher wins,
// so inline code shields its contents from emphasis and link parsing.
const INLINE_MATCHERS: InlineMatcher[] = [
  { re: /(`+)([\s\S]+?)\1(?!`)/g, build: (m) => [{ kind: "code", text: m[2] ?? "" }] },
  { re: /\*\*(?=\S)([\s\S]*?\S)\*\*(?!\*)/g, build: (m) => [{ kind: "strong", children: parseInline(m[1] ?? "") }] },
  { re: /__(?=\S)([\s\S]*?\S)__(?!_)/g, build: (m) => [{ kind: "strong", children: parseInline(m[1] ?? "") }] },
  { re: /\*(?=\S)([^*]*?\S)\*(?!\*)/g, build: (m) => [{ kind: "em", children: parseInline(m[1] ?? "") }] },
  { re: /(?<![\w`])_(?=\S)([^_]*?\S)_(?![\w])/g, build: (m) => [{ kind: "em", children: parseInline(m[1] ?? "") }] },
  { re: /~~(?=\S)([\s\S]*?\S)~~/g, build: (m) => [{ kind: "del", children: parseInline(m[1] ?? "") }] },
  {
    re: /!?\[([^\]]*)\]\(\s*((?:[^()\s]|\([^()\s]*\))*)(?:\s+"[^"]*")?\s*\)/g,
    build: (m) => {
      const label = parseInline(m[1] ?? "");
      const href = m[2] ?? "";
      return SAFE_HREF.test(href) ? [{ kind: "link", href, children: label }] : label;
    },
  },
  {
    // Ends on a non-punctuation char so a trailing "." or ")" stays ordinary text.
    re: /https?:\/\/[^\s<>"`)\]]*[^\s<>"`)\].,;:!?]/g,
    build: (m) => {
      const href = m[0] ?? "";
      return [{ kind: "link", href, children: [{ kind: "text", text: href }] }];
    },
  },
];

export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const pushText = (chunk: string) => {
    if (chunk === "") return;
    const last = tokens[tokens.length - 1];
    if (last?.kind === "text") last.text += chunk;
    else tokens.push({ kind: "text", text: chunk });
  };

  let pos = 0;
  while (pos < text.length) {
    let best: { index: number; match: RegExpExecArray; matcher: InlineMatcher } | null = null;
    for (const matcher of INLINE_MATCHERS) {
      matcher.re.lastIndex = pos;
      const match = matcher.re.exec(text);
      if (match && (best === null || match.index < best.index)) {
        best = { index: match.index, match, matcher };
      }
    }
    if (!best) {
      pushText(text.slice(pos));
      break;
    }
    pushText(text.slice(pos, best.index));
    for (const token of best.matcher.build(best.match)) {
      if (token.kind === "text") pushText(token.text);
      else tokens.push(token);
    }
    const consumed = best.match[0]?.length ?? 1;
    pos = best.index + Math.max(consumed, 1);
  }
  return tokens;
}
