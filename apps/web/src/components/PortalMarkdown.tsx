"use client";

import { memo, useSyncExternalStore, type ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import CodeBlock from "./CodeBlock";
import { pushPath } from "@/lib/navigation";
import { inAppLinkPath } from "@/lib/session-routes";

const noSubscription = () => () => {};

/** The page's origin, read outside render: null on the server and during hydration, the browser's after. */
function useOrigin(): string | null {
  return useSyncExternalStore(
    noSubscription,
    () => window.location.origin,
    () => null,
  );
}

/**
 * Links to tabs (`/tabs/<id>`) and sessions (`/sessions/<id>`) in a reply navigate in place, the way the
 * app's own links do (the session path resolves to its tab); everything else opens in a new browser tab.
 * Paths are recognised without the origin; a full URL on this origin once the browser has said what it is.
 */
function MarkdownLink({ children, href, ...props }: ComponentProps<"a">) {
  const origin = useOrigin();
  const inApp = href ? inAppLinkPath(href, origin) : null;
  if (inApp)
    return (
      <a
        {...props}
        href={inApp}
        onClick={(event) => {
          if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          pushPath(inApp);
        }}
      >
        {children}
      </a>
    );
  return (
    <a {...props} href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

const components = {
  pre: CodeBlock,
  a: MarkdownLink,
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
  "[&_.code-block]:!my-1.5 [&_table]:!my-1.5 [&_blockquote]:!pl-3",
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
