import { GitBranch, PanelLeft, SquarePen, TerminalSquare } from "lucide-react";
import IconButton from "./IconButton";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { activityLabels, type AgentActivity } from "@/lib/agent-activity";
import type { RefObject } from "react";

export default function SessionHeader({
  title,
  activity,
  hasSession,
  showShell,
  showGithub,
  onSidebar,
  onNew,
  onTerminal,
  onGithub,
  shellButton,
}: {
  title: string;
  activity: AgentActivity;
  hasSession: boolean;
  showShell: boolean;
  showGithub: boolean;
  onSidebar: () => void;
  onNew: () => void;
  onTerminal: () => void;
  onGithub: () => void;
  shellButton: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <header className="workspace-header">
      <IconButton
        id="sidebar-toggle"
        label="Toggle sidebar"
        onClick={onSidebar}
        className="text-muted-foreground"
      >
        <PanelLeft className="size-4" />
      </IconButton>
      <div className="min-w-0 flex-1">
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={`Conversation title: ${title}`}
              className="block max-w-full rounded text-left"
            >
              <h1 className="line-clamp-2 text-[13px] font-medium leading-snug tracking-[-.01em]">
                {title}
              </h1>
            </button>
          </PopoverTrigger>
          <PopoverContent className="max-w-[calc(100vw-32px)] rounded-2xl text-sm leading-relaxed break-words">
            {title}
          </PopoverContent>
        </Popover>
        {hasSession && (
          <p
            role="status"
            data-activity={activity}
            className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground"
          >
            <span className="status-dot" />
            {activityLabels[activity]}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
        {hasSession && (
          <IconButton
            label="New conversation"
            onClick={onNew}
            className="hidden text-muted-foreground sm:inline-flex"
          >
            <SquarePen className="size-4" />
          </IconButton>
        )}
        {hasSession && (
          <IconButton
            ref={shellButton}
            id="terminal-toggle"
            label={showShell ? "Hide terminal" : "Show terminal"}
            aria-expanded={showShell}
            aria-controls="terminal-panel"
            onClick={onTerminal}
            className={
              showShell ? "bg-white/8 text-foreground" : "text-muted-foreground"
            }
          >
            <TerminalSquare className="size-4" />
          </IconButton>
        )}
        <IconButton
          id="github-toggle"
          label={
            showGithub ? "Close GitHub inspector" : "Open GitHub inspector"
          }
          aria-expanded={showGithub}
          aria-controls={showGithub ? "github-inspector" : undefined}
          onClick={onGithub}
          className={
            showGithub ? "bg-white/8 text-foreground" : "text-muted-foreground"
          }
        >
          <GitBranch className="size-4" />
        </IconButton>
      </div>
    </header>
  );
}
