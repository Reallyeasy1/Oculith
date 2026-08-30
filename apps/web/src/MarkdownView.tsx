import { Fragment, memo, useMemo, type ReactNode } from "react";
import { parseMarkdown, type InlineToken, type MarkdownBlock } from "./markdown";

// Renders assistant markdown as React elements only — no dangerouslySetInnerHTML —
// so model output can style itself but never inject markup (#378).

const HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

function renderInline(tokens: InlineToken[]): ReactNode[] {
  return tokens.map((token, index) => {
    switch (token.kind) {
      case "text":
        return token.text;
      case "code":
        return <code key={index}>{token.text}</code>;
      case "strong":
        return <strong key={index}>{renderInline(token.children)}</strong>;
      case "em":
        return <em key={index}>{renderInline(token.children)}</em>;
      case "del":
        return <del key={index}>{renderInline(token.children)}</del>;
      case "link":
        return (
          <a key={index} href={token.href} target="_blank" rel="noopener noreferrer">
            {renderInline(token.children)}
          </a>
        );
    }
  });
}

// Each soft-wrapped line gets its own keyed Fragment so renderInline's per-line
// indices never collide across sibling lines.
function renderLines(lines: InlineToken[][]): ReactNode[] {
  return lines.map((line, index) => (
    <Fragment key={index}>
      {index > 0 && <br />}
      {renderInline(line)}
    </Fragment>
  ));
}

function renderItem(item: MarkdownBlock[]): ReactNode {
  const [first, ...rest] = item;
  if (first?.kind === "paragraph") {
    return (
      <>
        {renderLines(first.lines)}
        {rest.map(renderBlock)}
      </>
    );
  }
  return item.map(renderBlock);
}

function renderBlock(block: MarkdownBlock, key: number): ReactNode {
  switch (block.kind) {
    case "heading": {
      const Tag = HEADING_TAGS[block.level - 1] ?? "h6";
      return <Tag key={key}>{renderInline(block.children)}</Tag>;
    }
    case "paragraph":
      return <p key={key}>{renderLines(block.lines)}</p>;
    case "code":
      return (
        <pre key={key}>
          <code className={block.language ? "language-" + block.language : undefined}>{block.text}</code>
        </pre>
      );
    case "list": {
      const children = block.items.map((item, index) => <li key={index}>{renderItem(item)}</li>);
      return block.ordered ? (
        <ol key={key} start={block.start}>
          {children}
        </ol>
      ) : (
        <ul key={key}>{children}</ul>
      );
    }
    case "blockquote":
      return <blockquote key={key}>{block.children.map(renderBlock)}</blockquote>;
    case "hr":
      return <hr key={key} />;
  }
}

// memo + useMemo: the message list re-renders on every composer keystroke and every
// run poll tick, and parsing must not be paid again for unchanged content.
export default memo(function MarkdownView({ source }: { source: string }) {
  const blocks = useMemo(() => {
    try {
      return parseMarkdown(source);
    } catch {
      // A parser bug must degrade to the plain-text rendering, not unmount the app.
      return null;
    }
  }, [source]);
  if (blocks === null) return <div className="markdown">{source}</div>;
  return <div className="markdown">{blocks.map(renderBlock)}</div>;
});
