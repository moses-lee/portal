"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Bot, FolderGit2, GitPullRequest, Loader2, Search, User } from "lucide-react";
import AgentLogo from "./AgentLogo";
import { useNow } from "./portal/PortalLive";
import { usePreference } from "./usePreference";
import { useMediaQuery } from "./useMediaQuery";
import { useSearch } from "./useSearch";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { relativeAge } from "@/lib/relative-age";
import {
  highlightRanges,
  matchProjects,
  matchSessions,
  MESSAGE_CAP,
  mergePullHits,
  newestSessions,
  parseRecents,
  pullLabel,
  RECENTS_KEY,
  resolveRecents,
  type RowPull,
} from "@/lib/search";
import { sessionDisplayTitle } from "@/lib/session-title";
import type { ProjectSummary, SessionSummary } from "@/lib/types";

export type SearchDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: SessionSummary[];
  projects: ProjectSummary[];
  /** Open a session from a session or message row; the dialog has closed by then. */
  onOpenSession: (id: string) => void;
  /** Open a start-page tab in a project. */
  onOpenProject: (id: string) => void;
};

/**
 * Global search (⌘K / Ctrl+K, or the sidebar's Search button): sessions and projects matched here
 * from the lists the client holds, message text and PR-linked sessions from `GET /api/search`.
 * Raycast-like on desktop (a bare input near the top over a blurred page); a bottom sheet on phones.
 * The panel mounts only while open, so the query, selection, and answer cache start fresh each time.
 */
export default function SearchDialog(props: SearchDialogProps) {
  const { open, onOpenChange } = props;
  const desktop = useMediaQuery("(min-width: 640px)", true);
  /**
   * Where focus goes back to on close: the composer, terminal, or button search was opened from.
   * Radix returns focus only to a `Trigger`, and the shortcut has none.
   */
  const returnTo = useRef<HTMLElement | null>(null);
  /** Set when a row was opened: focus then belongs to what opened, not to the element search was opened from. */
  const opened = useRef(false);
  // Runs before Radix focuses the input, so the active element is still the one search was opened from.
  const openAutoFocus = () => {
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  };
  const closeAutoFocus = (event: Event) => {
    event.preventDefault();
    const target = returnTo.current;
    // Gone (the phone's sidebar sheet held the Search button): the first sidebar toggle, as the sheet does.
    if (!opened.current && target) (target.isConnected ? target : document.getElementById("sidebar-toggle"))?.focus();
    opened.current = false;
    returnTo.current = null;
  };
  // Stable, so the panel's rows are not rebuilt on every render of the shell.
  const onOpened = useCallback(() => {
    opened.current = true;
    onOpenChange(false);
  }, [onOpenChange]);
  const panel = <SearchPanel {...props} onOpened={onOpened} />;
  if (!desktop)
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          data-search-dialog=""
          onOpenAutoFocus={openAutoFocus}
          onCloseAutoFocus={closeAutoFocus}
          className="glass gap-0 data-[side=bottom]:h-[85dvh] rounded-t-3xl p-0 pb-[env(safe-area-inset-bottom)]"
        >
          <SheetTitle className="sr-only">Search</SheetTitle>
          <SheetDescription className="sr-only">Find sessions, projects, and messages.</SheetDescription>
          {panel}
        </SheetContent>
      </Sheet>
    );
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 isolate z-50 bg-black/45 duration-100 supports-backdrop-filter:backdrop-blur-md data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Content
          data-search-dialog=""
          onOpenAutoFocus={openAutoFocus}
          onCloseAutoFocus={closeAutoFocus}
          className="glass fixed top-[12vh] left-1/2 z-50 flex h-[min(480px,76vh)] w-[min(640px,calc(100%-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-2xl text-sm text-popover-foreground outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.98] data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[0.98]"
        >
          <DialogPrimitive.Title className="sr-only">Search</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">Find sessions, projects, and messages.</DialogPrimitive.Description>
          {panel}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** One selectable row; `key` is unique across the whole list (a session can be in two sections). */
type Row = {
  key: string;
  icon: ReactNode;
  primary: ReactNode;
  subtitle: string;
  pull?: RowPull;
  time?: number;
  open: () => void;
};
type Section = { id: string; label: string; rows: Row[] };

/** A worktree project is named after its branch, so the subtitle would otherwise repeat it. */
function joinDistinct(...parts: (string | null | undefined)[]): string {
  return Array.from(new Set(parts.filter((p): p is string => Boolean(p)))).join(" · ");
}

function Highlight({ text, q }: { text: string; q: string }) {
  const ranges = highlightRanges(text, q);
  if (ranges.length === 0) return text;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <mark key={start} className="rounded-[3px] bg-amber-200/20 px-px text-foreground">
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

const iconBox = "flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/45 text-foreground/70";

function SearchPanel({
  sessions,
  projects,
  onOpenSession,
  onOpenProject,
  onOpened,
}: SearchDialogProps & { onOpened: () => void }) {
  const [query, setQuery] = useState("");
  const q = query.trim();
  const { data, loading, pending } = useSearch(q);
  const [recentsRaw] = usePreference(RECENTS_KEY, "[]");
  const now = useNow(30_000);
  const listId = useId();

  const sections = useMemo<Section[]>(() => {
    const sessionById = new Map(sessions.map((session) => [session.id, session]));
    const projectName = (session: SessionSummary) =>
      session.project?.name ?? projects.find((project) => project.id === session.projectId)?.name;
    const sessionRow = (section: string, session: SessionSummary, pull?: RowPull): Row => ({
      key: `${section}:session:${session.id}`,
      icon: <span className={iconBox}><AgentLogo agentId={session.agentId} className="size-4" /></span>,
      primary: <Highlight text={sessionDisplayTitle(session.title)} q={q} />,
      subtitle: joinDistinct(projectName(session), session.git?.branch),
      pull,
      time: session.lastActiveAt,
      open: () => {
        onOpened();
        onOpenSession(session.id);
      },
    });
    const projectRow = (section: string, project: ProjectSummary): Row => ({
      key: `${section}:project:${project.id}`,
      icon: <span className={iconBox}><FolderGit2 className="size-4" aria-hidden="true" /></span>,
      primary: <Highlight text={project.name} q={q} />,
      subtitle: joinDistinct(project.displayPath, project.worktree?.branch),
      open: () => {
        onOpened();
        onOpenProject(project.id);
      },
    });
    if (!q) {
      const recent = resolveRecents(parseRecents(recentsRaw), sessions, projects).map((entry) =>
        entry.kind === "session" ? sessionRow("recent", entry.session) : projectRow("recent", entry.project),
      );
      return [
        { id: "recent", label: "Recent", rows: recent },
        { id: "recent-sessions", label: "Recent sessions", rows: newestSessions(sessions).map((session) => sessionRow("sessions", session)) },
      ].filter((section) => section.rows.length > 0);
    }
    const sessionRows = mergePullHits(matchSessions(sessions, projects, q), data?.pulls ?? [], sessions).map((row) =>
      sessionRow("sessions", row.item, row.pull),
    );
    const messageRows = (data?.messages ?? []).flatMap((hit): Row[] => {
      const session = sessionById.get(hit.sessionId);
      if (!session) return [];
      const Icon = hit.role === "user" ? User : Bot;
      return [{
        key: `messages:${hit.sessionId}:${hit.seq}`,
        icon: (
          <span className={iconBox}>
            <Icon className="size-4" aria-label={hit.role === "user" ? "You" : "Agent"} />
          </span>
        ),
        primary: <Highlight text={hit.snippet} q={q} />,
        subtitle: sessionDisplayTitle(session.title),
        time: hit.ts,
        open: () => {
          onOpened();
          onOpenSession(session.id);
        },
      }];
    }).slice(0, MESSAGE_CAP);
    return [
      { id: "projects", label: "Projects", rows: matchProjects(projects, q).map((row) => projectRow("projects", row.item)) },
      { id: "sessions", label: "Sessions", rows: sessionRows },
      { id: "messages", label: "Messages", rows: messageRows },
    ].filter((section) => section.rows.length > 0);
  }, [q, sessions, projects, data, recentsRaw, onOpenSession, onOpenProject, onOpened]);

  const rows = useMemo(() => sections.flatMap((section) => section.rows), [sections]);
  /**
   * The selection, by row key and tied to the query it was made under: a new query starts at the
   * top, and server results arriving later do not move it off the row it is on.
   */
  const [picked, setPicked] = useState<{ q: string; key: string } | null>(null);
  const selectedKey =
    picked && picked.q === q && rows.some((row) => row.key === picked.key) ? picked.key : rows[0]?.key ?? null;
  const select = (key: string) => setPicked({ q, key });

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selectedKey) return;
    listRef.current?.querySelector(`[data-key="${CSS.escape(selectedKey)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedKey]);

  const move = (step: 1 | -1) => {
    if (rows.length === 0) return;
    const index = rows.findIndex((row) => row.key === selectedKey);
    select(rows[(index + step + rows.length) % rows.length].key);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || (event.ctrlKey && event.key === "n")) {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp" || (event.ctrlKey && event.key === "p")) {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      rows.find((row) => row.key === selectedKey)?.open();
    }
  };

  const optionId = (key: string) => `${listId}-${key}`;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-white/[0.07] px-4">
        <Search className="size-[18px] shrink-0 text-muted-foreground" aria-hidden="true" />
        {/* Radix focuses it on open (the first focusable), after noting what had focus. */}
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-label="Search"
          aria-expanded={rows.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={selectedKey ? optionId(selectedKey) : undefined}
          placeholder="Search sessions, projects, and messages"
          spellCheck={false}
          autoComplete="off"
          enterKeyHint="go"
          className="min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground/70"
        />
        {loading && <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-label="Searching" />}
      </div>
      <div ref={listRef} id={listId} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
        {sections.map((section) => (
          <div key={section.id} role="group" aria-labelledby={`${listId}-${section.id}`} className="mb-1.5">
            <div id={`${listId}-${section.id}`} className="px-2 pt-2 pb-1 text-[10px] font-semibold tracking-[0.18em] text-muted-foreground/80 uppercase">
              {section.label}
            </div>
            {section.rows.map((row) => {
              const selected = row.key === selectedKey;
              return (
                <div
                  key={row.key}
                  id={optionId(row.key)}
                  data-key={row.key}
                  role="option"
                  aria-selected={selected}
                  // Move, not enter: a list scrolled by the keyboard under a still pointer keeps its selection.
                  onMouseMove={() => !selected && select(row.key)}
                  onClick={row.open}
                  className={`flex cursor-default items-center gap-3 rounded-xl px-2 py-1.5 ${selected ? "bg-white/[0.08]" : ""}`}
                >
                  {row.icon}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-foreground/90">{row.primary}</span>
                    {row.subtitle && <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{row.subtitle}</span>}
                    {row.pull && (
                      <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
                        <GitPullRequest className="size-3 shrink-0" aria-hidden="true" />
                        <span className="truncate">{pullLabel(row.pull)}</span>
                      </span>
                    )}
                  </span>
                  {row.time !== undefined && (
                    <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{relativeAge(now - row.time)}</span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        {q && sections.length === 0 && !pending && (
          <p className="px-3 py-10 text-center text-[13px] text-muted-foreground">No results for “{q}”</p>
        )}
        {!q && sections.length === 0 && (
          <p className="px-3 py-10 text-center text-[13px] text-muted-foreground">Your sessions and projects will show here.</p>
        )}
      </div>
      <div className="hidden h-9 shrink-0 items-center gap-3 border-t border-white/[0.07] px-4 text-[11px] text-muted-foreground sm:flex">
        <span><Kbd>↑</Kbd><Kbd>↓</Kbd> navigate</span>
        <span><Kbd>↵</Kbd> open</span>
        <span><Kbd>esc</Kbd> close</span>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="mr-1 inline-flex h-4 min-w-4 items-center justify-center rounded border border-white/10 bg-white/[0.05] px-1 font-sans text-[10px] text-foreground/70">
      {children}
    </kbd>
  );
}
