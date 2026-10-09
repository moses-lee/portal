"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Bot, FolderGit2, GitPullRequest, Loader2, Search, Sparkles, User } from "lucide-react";
import AgentLogo from "./AgentLogo";
import { useNow, usePortalLive } from "./portal/PortalLive";
import { usePreference } from "./usePreference";
import { useMediaQuery } from "./useMediaQuery";
import { useSearch } from "./useSearch";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { pushPath } from "@/lib/navigation";
import { MAIN_THREAD_ID } from "@/lib/orchestrator/types";
import { relativeAge } from "@/lib/relative-age";
import {
  highlightRanges,
  isMacPlatform,
  matchProjects,
  matchSessions,
  MESSAGE_CAP,
  mergePullHits,
  newestSessions,
  parseRecents,
  pullLabel,
  RECENTS_KEY,
  resolveRecents,
  type PaletteTab,
  type RowPull,
} from "@/lib/search";
import { portalPath } from "@/lib/session-routes";
import { sessionDisplayTitle } from "@/lib/session-title";
import type { ProjectSummary, SessionSummary } from "@/lib/types";

/** The thread, its markdown and the chat SDK load when the Portal tab first opens, not with search. */
const PortalThread = dynamic(() => import("./portal/PortalThread"), {
  loading: () => (
    <div className="flex flex-1 items-center justify-center text-muted-foreground">
      <Loader2 className="size-4 animate-spin" aria-label="Opening Portal" />
    </div>
  ),
});

export type SearchDialogProps = {
  /** The open tab; null while the dialog is closed. */
  tab: PaletteTab | null;
  /** Switch tabs, or close with null. */
  onTabChange: (tab: PaletteTab | null) => void;
  sessions: SessionSummary[];
  projects: ProjectSummary[];
  /** Open a session from a session or message row; the dialog has closed by then. */
  onOpenSession: (id: string) => void;
  /** Open a start-page tab in a project. */
  onOpenProject: (id: string) => void;
};

const tabText = {
  search: { title: "Search", description: "Find sessions, projects, and messages." },
  portal: { title: "Portal", description: "Talk to Portal in its main thread." },
} as const;

/**
 * Global search (⌘K / Ctrl+K, or the sidebar's Search button) and Portal (⌘J / Ctrl+J), as two
 * tabs of one dialog. Search: sessions and projects matched here from the lists the client holds,
 * message text and PR-linked sessions from `GET /api/search`. Portal: the orchestrator's main
 * thread, the same conversation as the Portal page's Chat.
 * Raycast-like on desktop (near the top over a blurred page); a bottom sheet on phones. The
 * contents mount only while open, so the query, selection, and answer cache start fresh each time;
 * a tab once shown stays mounted until the dialog closes.
 */
export default function SearchDialog(props: SearchDialogProps) {
  const { tab, onTabChange } = props;
  const open = tab !== null;
  /** The tab on screen: the open one, kept through the closing animation. */
  const [shown, setShown] = useState<PaletteTab>(tab ?? "search");
  if (tab !== null && tab !== shown) setShown(tab);
  const desktop = useMediaQuery("(min-width: 640px)", true);
  const onOpenChange = useCallback((next: boolean) => !next && onTabChange(null), [onTabChange]);
  /**
   * Where focus goes back to on close: the composer, terminal, or button the dialog was opened from.
   * Radix returns focus only to a `Trigger`, and the shortcuts have none. Noted before the panels'
   * effects move focus into the dialog.
   */
  const returnTo = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (open) returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, [open]);
  /** Set when a row or link was opened: focus then belongs to what opened, not to the element the dialog was opened from. */
  const opened = useRef(false);
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
    onTabChange(null);
  }, [onTabChange]);
  const { title, description } = tabText[shown];
  const body = <PaletteBody {...props} tab={shown} onOpened={onOpened} />;
  if (!desktop)
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          data-search-dialog=""
          onCloseAutoFocus={closeAutoFocus}
          className="glass gap-0 data-[side=bottom]:h-[85dvh] rounded-t-3xl p-0 pb-[env(safe-area-inset-bottom)]"
        >
          <SheetTitle className="sr-only">{title}</SheetTitle>
          <SheetDescription className="sr-only">{description}</SheetDescription>
          {body}
        </SheetContent>
      </Sheet>
    );
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay data-room-slow="" className="fixed inset-0 isolate z-50 bg-black/45 duration-100 supports-backdrop-filter:backdrop-blur-md data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Content
          data-search-dialog=""
          onCloseAutoFocus={closeAutoFocus}
          className="glass fixed top-[12vh] left-1/2 z-50 flex h-[min(520px,calc(76vh+2.5rem))] w-[min(640px,calc(100%-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-2xl text-sm text-popover-foreground outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.98] data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[0.98]"
        >
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">{description}</DialogPrimitive.Description>
          {body}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

const tabs = [
  { id: "search", label: "Search", Icon: Search, letter: "K" },
  { id: "portal", label: "Portal", Icon: Sparkles, letter: "J" },
] as const;

type BodyProps = Omit<SearchDialogProps, "tab"> & { tab: PaletteTab; onOpened: () => void };

/** The tab strip over the two panels; the Portal panel mounts the first time its tab shows. */
function PaletteBody({ tab, onTabChange, onOpened, ...searchProps }: BodyProps) {
  const [portalMounted, setPortalMounted] = useState(tab === "portal");
  if (tab === "portal" && !portalMounted) setPortalMounted(true);
  // The dialog renders only on the client, once open.
  const [mac] = useState(() => isMacPlatform(navigator.platform));
  const baseId = useId();
  const tabId = (id: PaletteTab) => `${baseId}-tab-${id}`;
  const panelId = (id: PaletteTab) => `${baseId}-panel-${id}`;
  const strip = useRef<HTMLDivElement>(null);
  /**
   * Left and Right move between the tabs, as in any tab list. Focus stays on the strip: it is
   * taken back the frame after the shown panel focused its own field.
   */
  const onStripKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = tab === "search" ? "portal" : "search";
    onTabChange(next);
    requestAnimationFrame(() => strip.current?.querySelector<HTMLElement>(`#${CSS.escape(tabId(next))}`)?.focus());
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={strip}
        role="tablist"
        aria-label="Search or Portal"
        onKeyDown={onStripKeyDown}
        className="flex h-10 shrink-0 items-center gap-1 border-b border-white/[0.07] px-2"
      >
        {tabs.map(({ id, label, Icon, letter }) => {
          const selected = id === tab;
          return (
            <button
              key={id}
              id={tabId(id)}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={panelId(id)}
              tabIndex={selected ? 0 : -1}
              onClick={() => onTabChange(id)}
              className={`flex h-7 items-center gap-1.5 rounded-full px-3 text-xs transition-colors ${
                selected ? "bg-white/[0.1] text-foreground" : "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
              }`}
            >
              <Icon className="size-3.5" aria-hidden="true" />
              {label}
              <kbd aria-hidden="true" className="font-sans text-[10px] tracking-wide text-muted-foreground/70 max-sm:hidden">
                {mac ? `⌘${letter}` : `Ctrl ${letter}`}
              </kbd>
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={panelId("search")} aria-labelledby={tabId("search")} hidden={tab !== "search"} className="flex min-h-0 flex-1 flex-col">
        <SearchPanel {...searchProps} visible={tab === "search"} onOpened={onOpened} />
      </div>
      {portalMounted && (
        <div role="tabpanel" id={panelId("portal")} aria-labelledby={tabId("portal")} hidden={tab !== "portal"} className="flex min-h-0 flex-1 flex-col">
          <PortalPanel visible={tab === "portal"} onOpened={onOpened} />
        </div>
      )}
    </div>
  );
}

/**
 * The orchestrator's main thread, as on the Portal page: history, composer, drafts (shared with
 * the page). What it links to elsewhere in the app (a session or tab in a reply, a curation run)
 * closes the dialog and goes there.
 */
function PortalPanel({ visible, onOpened }: { visible: boolean; onOpened: () => void }) {
  const { threads } = usePortalLive();
  const thread = threads.find((candidate) => candidate.id === MAIN_THREAD_ID) ?? null;
  const root = useRef<HTMLDivElement>(null);
  const handlers = useMemo(
    () => ({
      onOpenCurationRun: (runId: string) => {
        onOpened();
        pushPath(portalPath({ view: "memory", entityId: null, runId }));
      },
    }),
    [onOpened],
  );
  const openWatches = useCallback(() => {
    onOpened();
    pushPath(portalPath("watches"));
  }, [onOpened]);
  // Focus the composer, caret at the end, when the tab shows; the thread's chunk may still be loading.
  useEffect(() => {
    const element = root.current;
    if (!visible || !element) return;
    const focus = () => {
      const textarea = element.querySelector("textarea");
      if (!textarea) return false;
      if (!textarea.disabled) {
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      }
      return true;
    };
    if (focus()) return;
    const observer = new MutationObserver(() => focus() && observer.disconnect());
    observer.observe(element, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [visible]);
  return (
    <div
      ref={root}
      // An in-app link in a reply navigates in place (it prevents the default); the dialog gives way to it.
      onClick={(event) => {
        const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
        if (link && !link.getAttribute("target") && event.defaultPrevented) onOpened();
      }}
      className="flex min-h-0 flex-1 flex-col [&_.composer-wrap]:!px-3 [&_.composer-wrap]:!pb-3 [&_.conversation-content]:!px-5 [&_.conversation-content]:!pt-5"
    >
      <PortalThread threadId={MAIN_THREAD_ID} thread={thread} visible={visible} handlers={handlers} onOpenWatches={openWatches} />
    </div>
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
  visible,
  onOpened,
}: Pick<SearchDialogProps, "sessions" | "projects" | "onOpenSession" | "onOpenProject"> & { visible: boolean; onOpened: () => void }) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (visible) inputRef.current?.focus();
  }, [visible]);
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
        {/* Focused whenever the tab shows. */}
        <input
          ref={inputRef}
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
