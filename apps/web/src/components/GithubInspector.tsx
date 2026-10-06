"use client";

import GithubPanel from "./GithubPanel";
import { useMediaQuery } from "./useMediaQuery";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import type { RefObject } from "react";
import type { GithubPanelProps } from "./GithubPanel";
import type { SessionSummary } from "@/lib/types";

export default function GithubInspector({
  open,
  onClose,
  projectId,
  projectRemoved,
  session,
  onGitAction,
  returnFocus,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string | null;
  projectRemoved: boolean;
  session?: SessionSummary;
  onGitAction?: GithubPanelProps["onGitAction"];
  /** The toggle that opened the sheet (one per pane); focus returns there when it closes. */
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const desktop = useMediaQuery("(min-width: 1280px)");
  const panel = (
    <GithubPanel
      projectId={projectId}
      projectRemoved={projectRemoved}
      session={session}
      onClose={onClose}
      visible={open}
      onGitAction={
        // The sheet covers the composer the action just filled; get out of its way.
        desktop || !onGitAction
          ? onGitAction
          : (kind, summary) => {
              onGitAction(kind, summary);
              onClose();
            }
      }
    />
  );
  if (!desktop)
    return (
      <Sheet
        open={open}
        onOpenChange={(value) => {
          if (!value) onClose();
        }}
      >
        <SheetContent
          id="github-inspector"
          className="!w-[min(380px,92vw)] gap-0 p-4"
          showCloseButton={false}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // The opener may be gone (its pane closed, its tab unmounted): then the first toggle on the page.
            const opener = returnFocus?.current;
            (opener?.isConnected ? opener : document.getElementById("github-toggle"))?.focus();
          }}
        >
          <SheetTitle className="sr-only">GitHub inspector</SheetTitle>
          <SheetDescription className="sr-only">
            Branch, pull request, checks, and commits.
          </SheetDescription>
          {panel}
        </SheetContent>
      </Sheet>
    );
  if (!open) return null;
  return (
    <aside
      id="github-inspector"
      aria-label="GitHub inspector"
      className="glass-subtle flex w-[340px] shrink-0 flex-col border-l border-white/5 px-4 py-4 animate-in fade-in slide-in-from-right-2 duration-200"
    >
      {panel}
    </aside>
  );
}
