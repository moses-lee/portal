"use client";

import { X } from "lucide-react";
import GithubPanel from "./GithubPanel";
import IconButton from "./IconButton";
import { useMediaQuery } from "./useMediaQuery";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import type { GithubPanelProps } from "./GithubPanel";
import type { SessionSummary } from "@/lib/types";

export default function GithubInspector({
  open,
  onClose,
  projectId,
  projectRemoved,
  session,
  onGitAction,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string | null;
  projectRemoved: boolean;
  session?: SessionSummary;
  onGitAction?: GithubPanelProps["onGitAction"];
}) {
  const desktop = useMediaQuery("(min-width: 1280px)");
  const panel = (
    <GithubPanel
      projectId={projectId}
      projectRemoved={projectRemoved}
      session={session}
      collapsed={false}
      onToggle={onClose}
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
          className="!w-[min(380px,92vw)] gap-5 p-5 pt-12"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            document.getElementById("github-toggle")?.focus();
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
      className="glass-subtle flex w-[340px] shrink-0 flex-col border-l border-white/5 px-5 py-4 animate-in fade-in slide-in-from-right-2 duration-200"
    >
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[10px] font-semibold tracking-[.12em] text-muted-foreground uppercase">
          Source control
        </span>
        <IconButton
          label="Close GitHub inspector"
          onClick={onClose}
          className="text-muted-foreground"
        >
          <X className="size-4" />
        </IconButton>
      </div>
      {panel}
    </aside>
  );
}
