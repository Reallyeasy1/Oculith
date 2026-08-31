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
    {
      name: "a soft-wrapped year does not interrupt a paragraph as an ordered list",
      source: "The release shipped in\n2024. It was great.",
      expected: [{ kind: "paragraph", lines: [[text("The release shipped in")], [text("2024. It was great.")]] }],
    },
    {
      name: "ordered list not starting at 1 still starts a fresh block after a blank line",
      source: "intro\n\n2. two",
      expected: [
        { kind: "paragraph", lines: [[text("intro")]] },
        { kind: "list", ordered: true, start: 2, items: [[{ kind: "paragraph", lines: [[text("two")]] }]] },
      ],
    },
    {
      name: "indented lines at a block boundary are verbatim code",
      source: "    const x = 1;\n    done()",
      expected: [{ kind: "code", language: "", text: "const x = 1;\ndone()" }],
    },
    {
      name: "indented lines cannot interrupt a paragraph — trees stay one block",
      source: "src/\n    main.ts\n    util.ts",
      expected: [{ kind: "paragraph", lines: [[text("src/")], [text("    main.ts")], [text("    util.ts")]] }],
    },
  ];

  it.each(cases)("$name", ({ source, expected }) => {
    expect(parseMarkdown(source)).toEqual(expected);
  });
});

describe("hostile input degrades instead of crashing", () => {
  it("a run of 20,000 asterisks parses without throwing", () => {
    expect(() => parseMarkdown("note: " + "*".repeat(20_000))).not.toThrow();
  });

  it("3,000 nested blockquote markers parse without throwing", () => {
    expect(() => parseMarkdown("> ".repeat(3_000) + "x")).not.toThrow();
  });

  it("deeply nested emphasis is capped, and the tail stays literal text", () => {
    const blocks = parseMarkdown("**".repeat(40) + "core" + "**".repeat(40));
    expect(blocks).toHaveLength(1);
    const flat = JSON.stringify(blocks);
    expect(flat).toContain("core");
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
      name: "unsafe scheme never becomes a link — the literal source is kept",
      source: "[click](javascript:alert(1))",
      expected: [text("[click](javascript:alert(1))")],
    },
    {
      name: "relative-path link keeps its readable literal instead of losing the path",
      source: "see [the config](./apps/server/config.yaml)",
      expected: [text("see [the config](./apps/server/config.yaml)")],
    },
    {
      name: "a URL used as a link label does not nest a second link",
      source: "[https://a.com](https://b.com)",
      expected: [{ kind: "link", href: "https://b.com", children: [text("https://a.com")] }],
    },
    {
      name: "autolink keeps balanced parens and drops trailing punctuation",
      source: "see https://ex.com/a_(b)_c.",
      expected: [
        text("see "),
        { kind: "link", href: "https://ex.com/a_(b)_c", children: [text("https://ex.com/a_(b)_c")] },
        text("."),
      ],
    },
    {
      name: "underscore emphasis works at word boundaries",
      source: "say _hi_ now",
      expected: [text("say "), { kind: "em", children: [text("hi")] }, text(" now")],
    },
    {
      name: "python dunders stay literal — no __strong__ matcher",
      source: "Override __init__ and __repr__ in my_class.py",
      expected: [text("Override __init__ and __repr__ in my_class.py")],
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
