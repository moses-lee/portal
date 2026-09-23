"use client";

import { memo, type ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

const components = {
  a: ({ children, ...props }: ComponentProps<"a">) => (
    <a {...props} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
};
const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHighlight];

/**
 * The item-card size: 13px text and lists that sit tight, so a body like "PRs waiting on you:"
 * plus one bullet per repo stays a few lines. `.conversation-markdown` (globals.css) is written
 * outside Tailwind's layers, so its paragraph and list spacing can only be overridden with `!`.
 */
const compactClassName = [
  "!text-[13px] !leading-[1.55]",
  "[&_p]:!my-1 [&_ul]:!my-1 [&_ol]:!my-1",
  "[&_ul]:!pl-4 [&_ol]:!pl-4 [&_li]:!my-0.5 [&_li]:!pl-0.5",
  "[&_h1]:!my-1.5 [&_h2]:!my-1.5 [&_h3]:!my-1.5 [&_h1]:!text-[14px] [&_h2]:!text-[14px] [&_h3]:!text-[13px]",
  "[&_pre]:!my-1.5 [&_table]:!my-1.5 [&_blockquote]:!pl-3",
].join(" ");

/**
 * Markdown with the conversation's plugins and styles (`.conversation-markdown`), for the
 * orchestrator's replies and item bodies. `compact` is the item-card size.
 */
const PortalMarkdown = memo(function PortalMarkdown({
  text,
  compact = false,
}: {
  text: string;
  compact?: boolean;
}) {
  return (
    <div className={compact ? `conversation-markdown ${compactClassName}` : "conversation-markdown"}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

export default PortalMarkdown;
