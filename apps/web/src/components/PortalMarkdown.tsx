"use client";

import { createContext, memo, useContext, useMemo, useSyncExternalStore, type ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import CodeBlock from "./CodeBlock";
import { requestAppNavigation } from "@/lib/surface-navigation";
import { classifyHref, isAbsolutePath, keepMarkdownUrl, rehypePathTokens } from "@/lib/file-links";
import FileLink, { DetectedPath, FileLinkContext, NoDetectedPaths } from "./files/FileLink";

const noSubscription = () => () => {};
const NavigationContext = createContext(requestAppNavigation);

/** The page's origin, read outside render: null on the server and during hydration, the browser's after. */
function useOrigin(): string | null {
  return useSyncExternalStore(
    noSubscription,
    () => window.location.origin,
    () => null,
  );
}

type MarkdownProps<T extends "a" | "code" | "span"> = ComponentProps<T> & { node?: unknown };

/** react-markdown hands every renderer its hast `node`; it is not a DOM attribute. */
function withoutNode<T extends { node?: unknown }>(props: T): Omit<T, "node"> {
  const rest = { ...props };
  delete rest.node;
  return rest;
}

/**
 * A link in a reply (docs/FILES.md, "Agent markdown links"), by `classifyHref`: internal links open
 * their workspace tab, page overlay, or the Agent chat in place; file paths open a file pane;
 * everything else opens in a new browser tab. Without a working directory, a relative path is
 * left as text: there is nothing to resolve it against.
 * Paths are recognised without the origin; a full URL on this origin once the browser has said what it is.
 */
export function MarkdownLink(markdownProps: MarkdownProps<"a">) {
  const { children: text, href, ...props } = withoutNode(markdownProps);
  const origin = useOrigin();
  const navigate = useContext(NavigationContext);
  const { cwd } = useContext(FileLinkContext);
  const target = classifyHref(href, origin);
  const children = <NoDetectedPaths>{text}</NoDetectedPaths>;
  if (target.kind === "app")
    return (
      <a
        {...props}
        href={target.path}
        onClick={(event) => {
          if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          navigate(target.path);
        }}
      >
        {children}
      </a>
    );
  if (target.kind === "file")
    return cwd || isAbsolutePath(target.path) ? (
      <FileLink {...props} path={target.path} line={target.line} cwd={cwd}>
        {children}
      </FileLink>
    ) : (
      <>{children}</>
    );
  if (target.kind === "text") return children;
  if (target.kind === "none")
    return (
      <a {...props} href={href}>
        {children}
      </a>
    );
  return (
    <a {...props} href={target.href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

/** Inline code that names a file that exists becomes a link to it (decision 14). Fenced code always ends in a newline. */
export function MarkdownCode(markdownProps: MarkdownProps<"code">) {
  const { children, ...props } = withoutNode(markdownProps);
  const code = <code {...props}>{children}</code>;
  if (typeof children !== "string" || children.includes("\n") || props.className) return code;
  return <DetectedPath text={children}>{code}</DetectedPath>;
}

/** The words `rehypePathTokens` marked as possible paths; every other span (highlighting) as it is. */
export function MarkdownSpan(markdownProps: MarkdownProps<"span">) {
  const { children, ...props } = withoutNode(markdownProps);
  const token = (props as Record<string, unknown>)["data-path-token"];
  if (typeof token === "string") return <DetectedPath text={token}>{children}</DetectedPath>;
  return <span {...props}>{children}</span>;
}

/** The renderers every reply shares: code blocks, links, and paths. */
export const markdownComponents = {
  pre: CodeBlock,
  a: MarkdownLink,
  code: MarkdownCode,
  span: MarkdownSpan,
};
export const markdownRemarkPlugins = [remarkGfm];
export const markdownRehypePlugins = [rehypeHighlight, rehypePathTokens];

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
 * orchestrator's replies and item bodies. `compact` is the item-card size. Paths in a reply still
 * `streaming` are checked for existence only once it settles (each prefix of a path would be asked about).
 */
const PortalMarkdown = memo(function PortalMarkdown({
  text,
  compact = false,
  onNavigate,
  cwd = null,
  streaming = false,
}: {
  text: string;
  compact?: boolean;
  streaming?: boolean;
  /** What relative file paths resolve against (a session's cwd, a previewed file's folder); without one, only absolute paths link. */
  cwd?: string | null;
  /** A conversation can dismiss its popup before the shell opens an internal destination. */
  onNavigate?: (path: string) => void;
}) {
  const files = useMemo(() => ({ cwd, check: !streaming }), [cwd, streaming]);
  return (
    <NavigationContext value={onNavigate ?? requestAppNavigation}>
      <FileLinkContext value={files}>
        <div className={compact ? `conversation-markdown ${compactClassName}` : "conversation-markdown"}>
          <ReactMarkdown
            remarkPlugins={markdownRemarkPlugins}
            rehypePlugins={markdownRehypePlugins}
            components={markdownComponents}
            urlTransform={keepMarkdownUrl}
          >
            {text}
          </ReactMarkdown>
        </div>
      </FileLinkContext>
    </NavigationContext>
  );
});

export default PortalMarkdown;
