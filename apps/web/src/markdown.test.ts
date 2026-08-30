import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, type InlineToken, type MarkdownBlock } from "./markdown";

const text = (t: string): InlineToken => ({ kind: "text", text: t });

describe("parseMarkdown blocks", () => {
  const cases: Array<{ name: string; source: string; expected: MarkdownBlock[] }> = [
    {
      name: "heading levels with inline content",
      source: "## Plan **now**",
      expected: [{ kind: "heading", level: 2, children: [text("Plan "), { kind: "strong", children: [text("now")] }] }],
    },
    {
      name: "paragraph keeps soft line breaks as separate lines",
      source: "first line\nsecond line",
      expected: [{ kind: "paragraph", lines: [[text("first line")], [text("second line")]] }],
    },
    {
      name: "blank line splits paragraphs",
      source: "one\n\ntwo",
      expected: [
        { kind: "paragraph", lines: [[text("one")]] },
        { kind: "paragraph", lines: [[text("two")]] },
      ],
    },
    {
      name: "fenced code block with language keeps content verbatim",
      source: "```ts\nconst a = **not bold**;\n```",
      expected: [{ kind: "code", language: "ts", text: "const a = **not bold**;" }],
    },
    {
      name: "unclosed fence swallows the rest of the message",
      source: "```\nline one\nline two",
      expected: [{ kind: "code", language: "", text: "line one\nline two" }],
    },
    {
      name: "unordered list",
      source: "- alpha\n- beta",
      expected: [
        {
          kind: "list",
          ordered: false,
          start: 1,
          items: [
            [{ kind: "paragraph", lines: [[text("alpha")]] }],
            [{ kind: "paragraph", lines: [[text("beta")]] }],
          ],
        },
      ],
    },
    {
      name: "ordered list keeps its start number",
      source: "3. third\n4. fourth",
      expected: [
        {
          kind: "list",
          ordered: true,
          start: 3,
          items: [
            [{ kind: "paragraph", lines: [[text("third")]] }],
            [{ kind: "paragraph", lines: [[text("fourth")]] }],
          ],
        },
      ],
    },
    {
      name: "nested list becomes a block inside the parent item",
      source: "- outer\n  - inner",
      expected: [
        {
          kind: "list",
          ordered: false,
          start: 1,
          items: [
            [
              { kind: "paragraph", lines: [[text("outer")]] },
              {
                kind: "list",
                ordered: false,
                start: 1,
                items: [[{ kind: "paragraph", lines: [[text("inner")]] }]],
              },
            ],
          ],
        },
      ],
    },
    {
      name: "blockquote parses its content recursively",
      source: "> quoted\n> more",
      expected: [{ kind: "blockquote", children: [{ kind: "paragraph", lines: [[text("quoted")], [text("more")]] }] }],
    },
    {
      name: "horizontal rule",
      source: "before\n\n---\n\nafter",
      expected: [
        { kind: "paragraph", lines: [[text("before")]] },
        { kind: "hr" },
        { kind: "paragraph", lines: [[text("after")]] },
      ],
    },
    {
      name: "raw HTML stays literal text — never interpreted",
      source: "<script>alert(1)</script>",
      expected: [{ kind: "paragraph", lines: [[text("<script>alert(1)</script>")]] }],
    },
    {
      name: "list interrupts a paragraph",
      source: "intro:\n- item",
      expected: [
        { kind: "paragraph", lines: [[text("intro:")]] },
        { kind: "list", ordered: false, start: 1, items: [[{ kind: "paragraph", lines: [[text("item")]] }]] },
      ],
    },
  ];

  it.each(cases)("$name", ({ source, expected }) => {
    expect(parseMarkdown(source)).toEqual(expected);
  });
});

describe("parseInline", () => {
  const cases: Array<{ name: string; source: string; expected: InlineToken[] }> = [
    {
      name: "inline code wins over emphasis inside it",
      source: "run `npm **check**` now",
      expected: [text("run "), { kind: "code", text: "npm **check**" }, text(" now")],
    },
    {
      name: "bold, italic and strikethrough",
      source: "**bold** *it* ~~gone~~",
      expected: [
        { kind: "strong", children: [text("bold")] },
        text(" "),
        { kind: "em", children: [text("it")] },
        text(" "),
        { kind: "del", children: [text("gone")] },
      ],
    },
    {
      name: "emphasis nests",
      source: "**bold *inner***",
      expected: [{ kind: "strong", children: [text("bold "), { kind: "em", children: [text("inner")] }] }],
    },
    {
      name: "http link keeps its href",
      source: "see [docs](https://example.com/a)",
      expected: [text("see "), { kind: "link", href: "https://example.com/a", children: [text("docs")] }],
    },
    {
      name: "unsafe scheme is dropped — label survives as plain content",
      source: "[click](javascript:alert(1))",
      expected: [text("click")],
    },
    {
      name: "bare URL autolinks",
      source: "at https://example.com/x?a=1 today",
      expected: [
        text("at "),
        { kind: "link", href: "https://example.com/x?a=1", children: [text("https://example.com/x?a=1")] },
        text(" today"),
      ],
    },
    {
      name: "image syntax renders as a link to the image",
      source: "![diagram](https://example.com/d.png)",
      expected: [{ kind: "link", href: "https://example.com/d.png", children: [text("diagram")] }],
    },
    {
      name: "unmatched markers stay literal",
      source: "2 * 3 * 4 and a_b",
      expected: [text("2 * 3 * 4 and a_b")],
    },
  ];

  it.each(cases)("$name", ({ source, expected }) => {
    expect(parseInline(source)).toEqual(expected);
  });
});
