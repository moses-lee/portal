"use client";

import { Children, isValidElement, type ComponentProps, type ReactNode } from "react";
import CopyButton from "./CopyButton";

function textContent(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      isValidElement<{ children?: ReactNode }>(child)
        ? textContent(child.props.children)
        : typeof child === "string" || typeof child === "number"
          ? String(child)
          : "",
    )
    .join("");
}

/**
 * A fenced code block in rendered Markdown (`pre`): a language label, a copy button, and a body that
 * scrolls sideways on its own, so a long line never widens the message around it.
 */
export default function CodeBlock({ children }: ComponentProps<"pre">) {
  const child = Children.toArray(children)[0];
  const language = isValidElement<{ className?: string }>(child)
    ? /language-([\w+-]+)/.exec(child.props.className ?? "")?.[1]
    : undefined;
  return (
    <div className="code-block">
      <div className="flex items-center justify-between border-b border-white/5 px-3 py-1.5">
        <span className="font-mono text-[10px] text-muted-foreground">
          {language ?? "Code"}
        </span>
        <CopyButton
          text={textContent(children)}
          label="Copy code"
          className="text-muted-foreground"
        />
      </div>
      <pre>{children}</pre>
    </div>
  );
}
