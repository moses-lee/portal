"use client";

import { createContext, useContext, useMemo, type ComponentProps, type ReactNode } from "react";
import { isAbsolutePath, pathCandidate, rawFileUrl } from "@/lib/file-links";
import { useOpenFile } from "./useOpenFile";
import { usePathExists } from "./useExistingPaths";

/**
 * What file links in rendered text resolve against: the session's working directory (null where
 * there is none, as in Agent replies: then only absolute and `~/` paths link), and whether
 * detected paths may be checked for existence yet (not while a reply is still streaming).
 */
export const FileLinkContext = createContext<{ cwd: string | null; check: boolean; inLink?: boolean }>({
  cwd: null,
  check: true,
});

/** Inside a link already: code in its text must not become a second, nested link. */
export function NoDetectedPaths({ children }: { children: ReactNode }) {
  const files = useContext(FileLinkContext);
  const value = useMemo(() => ({ ...files, inLink: true }), [files]);
  return <FileLinkContext value={value}>{children}</FileLinkContext>;
}

/** Dotted underline: a path Portal found in the text, as opposed to a link the agent wrote. */
const detectedClassName =
  "cursor-pointer underline decoration-dotted decoration-muted-foreground/60 underline-offset-[3px] hover:decoration-solid";

/**
 * A link to a file: a plain click opens it in a file pane; ⌘/Ctrl-click and middle-click open the
 * raw bytes in a browser tab (the `href`), so it never leads to a Portal URL that 404s.
 */
export default function FileLink({
  path,
  line,
  cwd,
  detected = false,
  className,
  children,
  ...props
}: Omit<ComponentProps<"a">, "href" | "target"> & {
  path: string;
  line?: number | null;
  cwd?: string | null;
  /** Found in text rather than linked by the agent: drawn with a dotted underline. */
  detected?: boolean;
}) {
  const openFile = useOpenFile();
  return (
    <a
      title={line ? `${path}:${line}` : path}
      {...props}
      href={rawFileUrl(path, cwd)}
      target="_blank"
      rel="noreferrer"
      className={[detected ? detectedClassName : "", className ?? ""].join(" ").trim() || undefined}
      onClick={(event) => {
        props.onClick?.(event);
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        openFile({ path, cwd, line });
      }}
    >
      {children}
    </a>
  );
}

/**
 * Text that may be a path (an inline code span's content or a bare word): a file link once the
 * server says it exists, otherwise `children` as they are. Relative paths need a working directory.
 */
export function DetectedPath({ text, children }: { text: string; children: ReactNode }) {
  const { cwd, check, inLink } = useContext(FileLinkContext);
  const candidate = inLink ? null : pathCandidate(text);
  const linkable = candidate && (cwd || isAbsolutePath(candidate.path)) ? candidate : null;
  const exists = usePathExists(linkable?.path ?? null, cwd, check);
  if (!linkable || !exists) return children;
  return (
    <FileLink path={linkable.path} line={linkable.line} cwd={cwd} detected>
      {children}
    </FileLink>
  );
}

/** A tool call's reported file (`locations`, a diff's header): always a link, it was named by the agent. */
export function ToolFileLink({ path, line, className }: { path: string; line?: number | null; className?: string }) {
  const { cwd } = useContext(FileLinkContext);
  return (
    <FileLink
      path={path}
      line={line}
      cwd={cwd}
      className={className ?? "underline-offset-2 transition-colors hover:text-foreground hover:underline"}
    >
      {line ? `${path}:${line}` : path}
    </FileLink>
  );
}
