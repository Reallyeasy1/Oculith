// Minimal GFM-subset parser for assistant replies (#378). No dependencies by design
// (.claude/rules/web.md); safety comes from the renderer emitting React elements only,
// so anything this parser leaves as "text" can never become live HTML.
//
// Recursion is depth-capped in both the block and inline grammars: model output is
// untrusted and a run of 20,000 asterisks or 3,000 ">" must degrade to literal text,
// not a RangeError that unmounts the app (PR #380 review).

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

const MAX_BLOCK_DEPTH = 8;
const MAX_INLINE_DEPTH = 8;

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BLOCKQUOTE = /^ {0,3}>/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/;

export function parseMarkdown(source: string): MarkdownBlock[] {
  return parseBlockLines(source.replace(/\r\n/g, "\n").split("\n"), 0);
}

function parseBlockLines(lines: string[], depth: number): MarkdownBlock[] {
  if (depth >= MAX_BLOCK_DEPTH) {
    const literal = lines.filter((line) => line.trim() !== "").map((line): InlineToken[] => [{ kind: "text", text: line }]);
    return literal.length > 0 ? [{ kind: "paragraph", lines: literal }] : [];
  }

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
      blocks.push({ kind: "blockquote", children: parseBlockLines(quoted, depth + 1) });
      continue;
    }

    // Indented code (4+ spaces) at a block boundary stays verbatim — Codex often
    // pastes snippets and directory trees without fences.
    if (leadingSpaces(line) >= 4) {
      const body: string[] = [];
      while (i < lines.length) {
        const current = lines[i] ?? "";
        if (current.trim() === "") {
          const ahead = nextNonBlank(lines, i + 1);
          if (ahead === null || leadingSpaces(lines[ahead] ?? "") < 4) break;
          body.push("");
          i += 1;
          continue;
        }
        if (leadingSpaces(current) < 4) break;
        body.push(current.slice(4));
        i += 1;
      }
      blocks.push({ kind: "code", language: "", text: body.join("\n") });
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
        items.push(parseBlockLines(itemLines, depth + 1));
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

    // Lines are NOT trimmed: the wrapper inherits pre-wrap, so author spacing in
    // unmodeled content (aligned columns, ASCII trees, pipe tables) survives intact.
    const paragraph: InlineToken[][] = [];
    while (i < lines.length) {
      const current = lines[i] ?? "";
      if (current.trim() === "") break;
      if (FENCE_OPEN.test(current) || HEADING.test(current) || HR.test(current) || BLOCKQUOTE.test(current) || interruptsParagraph(current)) break;
      paragraph.push(parseInline(current));
      i += 1;
    }
    blocks.push({ kind: "paragraph", lines: paragraph });
  }
  return blocks;
}

// Only a bullet or a "1." item interrupts a paragraph (CommonMark): a soft-wrapped
// "…shipped in\n2024. It was great." must not become <ol start="2024">.
function interruptsParagraph(line: string): boolean {
  const m = line.match(LIST_ITEM);
  if (!m) return false;
  const marker = m[2] ?? "";
  if (!/^\d/.test(marker)) return true;
  return Number.parseInt(marker, 10) === 1;
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

type InlineContext = { depth: number; allowLinks: boolean };

type InlineMatcher = {
  re: RegExp;
  // Link matchers are disabled inside link labels so labels that are themselves
  // URLs never produce nested <a> elements.
  isLink?: boolean;
  // Opening delimiter must not follow a word char or backtick. Checked in code
  // instead of a lookbehind: Safari < 16.4 throws SyntaxError parsing lookbehind
  // at module load, which would blank the whole app.
  leftBoundary?: boolean;
  build: (m: RegExpExecArray, ctx: InlineContext) => InlineToken[];
};

// Priority order: earliest match wins; on a tie the earlier matcher wins,
// so inline code shields its contents from emphasis and link parsing.
// There is deliberately no __strong__ matcher: Codex uses ** for bold, while
// double underscores in its replies are almost always Python dunders
// (__init__, __repr__) that must stay literal.
const INLINE_MATCHERS: InlineMatcher[] = [
  { re: /(`+)([\s\S]+?)\1(?!`)/g, build: (m) => [{ kind: "code", text: m[2] ?? "" }] },
  {
    re: /\*\*(?=\S)([\s\S]*?\S)\*\*(?!\*)/g,
    build: (m, ctx) => [{ kind: "strong", children: parseInlineWith(m[1] ?? "", deeper(ctx)) }],
  },
  {
    re: /\*(?=\S)([^*]*?\S)\*(?!\*)/g,
    build: (m, ctx) => [{ kind: "em", children: parseInlineWith(m[1] ?? "", deeper(ctx)) }],
  },
  {
    re: /_(?=\S)([^_]*?\S)_(?!\w)/g,
    leftBoundary: true,
    build: (m, ctx) => [{ kind: "em", children: parseInlineWith(m[1] ?? "", deeper(ctx)) }],
  },
  {
    re: /~~(?=\S)([\s\S]*?\S)~~/g,
    build: (m, ctx) => [{ kind: "del", children: parseInlineWith(m[1] ?? "", deeper(ctx)) }],
  },
  {
    re: /!?\[([^\]]*)\]\(\s*((?:[^()\s]|\([^()\s]*\))*)(?:\s+"[^"]*")?\s*\)/g,
    isLink: true,
    build: (m, ctx) => {
      const href = m[2] ?? "";
      if (!SAFE_HREF.test(href)) {
        // Keep the literal source so a relative or file: path is still readable
        // and copyable instead of silently vanishing.
        return [{ kind: "text", text: m[0] ?? "" }];
      }
      const label = parseInlineWith(m[1] ?? "", { depth: ctx.depth + 1, allowLinks: false });
      return [{ kind: "link", href, children: label }];
    },
  },
  {
    // Balanced single-level parens are part of the URL (Wikipedia-style paths);
    // the final unit excludes trailing punctuation so "…example.com." keeps its dot
    // as ordinary text.
    re: /https?:\/\/(?:\([^\s()]*\)|[^\s<>"`()])*(?:\([^\s()]*\)|[^\s<>"`().,;:!?])/g,
    isLink: true,
    build: (m) => {
      const href = m[0] ?? "";
      return [{ kind: "link", href, children: [{ kind: "text", text: href }] }];
    },
  },
];

function deeper(ctx: InlineContext): InlineContext {
  return { depth: ctx.depth + 1, allowLinks: ctx.allowLinks };
}

function validLeftBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  return !/[\w`]/.test(text.charAt(index - 1));
}

export function parseInline(text: string): InlineToken[] {
  return parseInlineWith(text, { depth: 0, allowLinks: true });
}

function parseInlineWith(text: string, ctx: InlineContext): InlineToken[] {
  if (ctx.depth >= MAX_INLINE_DEPTH) {
    return text === "" ? [] : [{ kind: "text", text }];
  }

  const tokens: InlineToken[] = [];
  const pushText = (chunk: string) => {
    if (chunk === "") return;
    const last = tokens[tokens.length - 1];
    if (last?.kind === "text") last.text += chunk;
    else tokens.push({ kind: "text", text: chunk });
  };

  // Per-call cache of each matcher's next match keeps the scan linear: a matcher
  // is only re-run once the cursor passes its cached position.
  const cache: Array<RegExpExecArray | null | undefined> = new Array(INLINE_MATCHERS.length).fill(undefined);

  let pos = 0;
  while (pos < text.length) {
    let best: { index: number; match: RegExpExecArray; matcher: InlineMatcher } | null = null;
    for (let k = 0; k < INLINE_MATCHERS.length; k += 1) {
      const matcher = INLINE_MATCHERS[k];
      if (!matcher) continue;
      if (matcher.isLink && !ctx.allowLinks) continue;
      let match = cache[k];
      if (match === undefined || (match !== null && match.index < pos)) {
        matcher.re.lastIndex = pos;
        match = matcher.re.exec(text);
        while (match && matcher.leftBoundary && !validLeftBoundary(text, match.index)) {
          matcher.re.lastIndex = match.index + 1;
          match = matcher.re.exec(text);
        }
        cache[k] = match;
      }
      if (match && (best === null || match.index < best.index)) {
        best = { index: match.index, match, matcher };
      }
    }
    if (!best) {
      pushText(text.slice(pos));
      break;
    }
    pushText(text.slice(pos, best.index));
    for (const token of best.matcher.build(best.match, ctx)) {
      if (token.kind === "text") pushText(token.text);
      else tokens.push(token);
    }
    const consumed = best.match[0]?.length ?? 1;
    pos = best.index + Math.max(consumed, 1);
  }
  return tokens;
}
