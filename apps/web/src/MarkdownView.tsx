import type { ReactNode } from "react";
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

function renderLines(lines: InlineToken[][]): ReactNode[] {
  return lines.flatMap((line, index) =>
    index === 0 ? renderInline(line) : [<br key={"br-" + index} />, ...renderInline(line)],
  );
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

export default function Markdown({ source }: { source: string }) {
  return <div className="markdown">{parseMarkdown(source).map(renderBlock)}</div>;
}
