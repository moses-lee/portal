import { useEffect, useRef, useState, type RefObject } from "react";
import {
  Eye,
  GitBranch,
  LayoutPanelLeft,
  PanelLeft,
  PencilLine,
  SquarePen,
  SquareArrowOutUpRight,
  SquareSplitHorizontal,
  SquareSplitVertical,
  TerminalSquare,
  X,
} from "lucide-react";
import IconButton from "./IconButton";
import { RenameField } from "./ProjectActions";
import { SESSION_TITLE_MAX } from "./SessionsProvider";
import { ContextActions, MenuItem, MenuSeparator } from "./ActionMenu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { activityLabels, type AgentActivity } from "@/lib/agent-activity";

/** The pane menu's actions (docs/WORKSPACE.md, "Pane header"); absent on the bare start page of an empty workspace. */
export type PaneMenu = {
  /** False when the workspace would refuse the split (the tab is full, or it would nest too deep): the item is disabled. */
  canSplitRight: boolean;
  canSplitDown: boolean;
  onSplitRight: () => void;
  onSplitDown: () => void;
  /** Offered when the pane shares its tab with others. */
  onMoveToTab: (() => void) | null;
  onClose: () => void;
};

export default function SessionHeader({
  title,
  activity,
  statusLabel,
  hasSession,
  showShell,
  showGithub,
  showSidebarToggle = true,
  onSidebar,
  onNew,
  onTerminal,
  onGithub,
  shellButton,
  terminalPanelId,
  tracked,
  trackPending,
  onToggleTrack,
  renameFrom,
  onRename,
  pane,
}: {
  title: string;
  /** The session's own title ("" while untitled) for the rename field; rename is offered only with `onRename`. */
  renameFrom?: string;
  /** Rename the open session; the caller reports failures. */
  onRename?: (title: string) => void;
  activity: AgentActivity;
  /** The status line's text (see `sessionStatusLabel`); the activity's label when absent. */
  statusLabel?: string;
  hasSession: boolean;
  showShell: boolean;
  showGithub: boolean;
  /** Only the first pane of a tab carries the sidebar toggle. */
  showSidebarToggle?: boolean;
  /** Open the sidebar; the opener is where focus returns when the sidebar sheet closes. */
  onSidebar: (opener: HTMLElement) => void;
  onNew: () => void;
  onTerminal: () => void;
  /** Toggle the GitHub inspector; the opener is where focus returns when its sheet closes. */
  onGithub: (opener: HTMLElement) => void;
  shellButton: RefObject<HTMLButtonElement | null>;
  /** The terminal panel's element id, for the toggle's `aria-controls`. */
  terminalPanelId?: string;
  /** Whether the session is in the tracked set (the Portal views' right panel lists it). */
  tracked: boolean;
  /** A track or untrack request is in flight. */
  trackPending: boolean;
  onToggleTrack: () => void;
  /** The pane menu: split, move to a tab, close. */
  pane?: PaneMenu;
}) {
  const [renaming, setRenaming] = useState(false);
  const renameInput = useRef<HTMLInputElement>(null);
  const renameButton = useRef<HTMLButtonElement>(null);
  // Focus the field once it is on screen (the button that opened it is gone by then).
  useEffect(() => {
    if (renaming) renameInput.current?.focus();
  }, [renaming]);
  /** Back to the title; after Enter or Escape focus would be lost with the field, so it returns to the pencil. */
  const stopRenaming = () => {
    setRenaming(false);
    requestAnimationFrame(() => {
      if (!document.activeElement || document.activeElement === document.body) renameButton.current?.focus();
    });
  };
  const paneItems = pane && (
    <>
      <MenuItem disabled={!pane.canSplitRight} onSelect={pane.onSplitRight}>
        <SquareSplitHorizontal />
        Split right
      </MenuItem>
      <MenuItem disabled={!pane.canSplitDown} onSelect={pane.onSplitDown}>
        <SquareSplitVertical />
        Split down
      </MenuItem>
      {pane.onMoveToTab && (
        <MenuItem onSelect={pane.onMoveToTab}>
          <SquareArrowOutUpRight />
          Move to its own tab
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuItem onSelect={pane.onClose}>
        <X />
        Close pane
      </MenuItem>
    </>
  );
  return (
    <ContextActions items={paneItems} disabled={!pane || renaming}>
      <header className="workspace-header">
        {showSidebarToggle && (
          <IconButton
            label="Toggle sidebar"
            onClick={(event) => onSidebar(event.currentTarget)}
            className="text-muted-foreground"
          >
            <PanelLeft className="size-4" />
          </IconButton>
        )}
        <div className="min-w-0 flex-1">
          {renaming && onRename ? (
            <RenameField
              inputRef={renameInput}
              initial={renameFrom ?? ""}
              ariaLabel="Conversation title"
              maxLength={SESSION_TITLE_MAX}
              className="w-full max-w-xl rounded-md border border-indigo-500 bg-zinc-900 px-2 py-0.5 text-[13px] font-medium leading-snug outline-none"
              onCancel={stopRenaming}
              onCommit={(next) => {
                stopRenaming();
                onRename(next);
              }}
            />
          ) : (
            <div className="group/title flex min-w-0 items-start gap-1">
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label={`Conversation title: ${title}`}
                    className="block min-w-0 max-w-full rounded text-left"
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
              {onRename && (
                <IconButton
                  ref={renameButton}
                  label="Rename conversation"
                  size="icon-xs"
                  onClick={() => setRenaming(true)}
                  className="-my-0.5 shrink-0 text-muted-foreground opacity-60 group-hover/title:opacity-100 focus-visible:opacity-100"
                >
                  <PencilLine />
                </IconButton>
              )}
            </div>
          )}
          {hasSession && (
            <p
              role="status"
              data-activity={activity}
              className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground"
            >
              <span className="status-dot shrink-0" />
              <span className="min-w-0 truncate">{statusLabel ?? activityLabels[activity]}</span>
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
              label="Track session"
              aria-pressed={tracked}
              disabled={trackPending}
              onClick={onToggleTrack}
              className={
                tracked ? "bg-white/8 text-foreground" : "text-muted-foreground"
              }
            >
              <Eye className="size-4" />
            </IconButton>
          )}
          {hasSession && (
            <IconButton
              ref={shellButton}
              label={showShell ? "Hide terminal" : "Show terminal"}
              aria-expanded={showShell}
              aria-controls={showShell ? terminalPanelId : undefined}
              onClick={onTerminal}
              className={
                showShell ? "bg-white/8 text-foreground" : "text-muted-foreground"
              }
            >
              <TerminalSquare className="size-4" />
            </IconButton>
          )}
          <IconButton
            label={
              showGithub ? "Close GitHub inspector" : "Open GitHub inspector"
            }
            aria-expanded={showGithub}
            aria-controls={showGithub ? "github-inspector" : undefined}
            onClick={(event) => onGithub(event.currentTarget)}
            className={
              showGithub ? "bg-white/8 text-foreground" : "text-muted-foreground"
            }
          >
            <GitBranch className="size-4" />
          </IconButton>
          {pane && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label="Pane options" className="text-muted-foreground">
                  <LayoutPanelLeft className="size-4" />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {paneItems}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>
    </ContextActions>
  );
}
