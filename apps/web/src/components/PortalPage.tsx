"use client";

import { useCallback, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { LoaderCircle, PanelLeft } from "lucide-react";
import AuroraBackground from "./AuroraBackground";
import IconButton from "./IconButton";
import PortalItemCard, { type ItemCardHandlers } from "./PortalItemCard";
import ResponsiveDialog from "./ResponsiveDialog";
import PortalStatusLine from "./portal/PortalStatusLine";
import PortalThread from "./portal/PortalThread";
import ThreadSwitcher from "./portal/ThreadSwitcher";
import { usePortalEvents, usePortalLive } from "./portal/PortalLive";
import { viewMeta } from "./portal/views";
import { readDraft, writeDraft } from "@/lib/drafts";
import { portalActivity } from "@/lib/orchestrator/format";
import { MAIN_THREAD_ID } from "@/lib/orchestrator/types";
import { portalLocation, portalPath, type PortalLocation, type PortalView } from "@/lib/session-routes";

/** Stands in for a view while its chunk loads: the views mount only when opened. */
function ViewLoading() {
  return (
    <div className="flex flex-1 items-center justify-center text-muted-foreground">
      <LoaderCircle className="size-4 animate-spin" />
    </div>
  );
}

/**
 * The views other than Chat load on demand so they stay off the home's (`/`) bundle: Chat is where
 * the app lands, and these unmount when left anyway. Their `PortalLinks` import is type-only.
 */
const GoalsView = dynamic(() => import("./portal/GoalsView"), { loading: ViewLoading });
const ActivityView = dynamic(() => import("./portal/ActivityView"), { loading: ViewLoading });
const MemoryView = dynamic(() => import("./portal/MemoryView"), { loading: ViewLoading });
const SystemView = dynamic(() => import("./portal/SystemView"), { loading: ViewLoading });

/**
 * Portal's pages: the orchestrator is the app's home. Chat (`/`) holds the main thread and the side
 * threads Portal opened (each its own conversation), and carries the live status line;
 * Goals the intents, upcoming jobs, and recent runs, Activity the audit log, Memory the curated
 * records, and System what the model is shown (CORE.md, the world) plus approval grants. The
 * sidebar switches between them and the URL says which, so reloads and links land in place. The
 * session pages' aurora sits behind every view: working while Portal answers the user, amber while
 * an approval waits.
 */
export default function PortalPage({
  pathname,
  onNavigate,
  onOpenSidebar,
  onOpenSession,
}: {
  pathname: string;
  /** Change the URL within the app (no server round trip). */
  onNavigate: (path: string) => void;
  onOpenSidebar: () => void;
  /** Navigate to a session, the way the sidebar does. */
  onOpenSession: (sessionId: string) => void;
}) {
  const live = usePortalLive();
  const { status, threads, putItem, requestApproval, items, approvals } = live;
  const location = useMemo(() => portalLocation(pathname), [pathname]);
  const view = location.view;
  const go = useCallback((to: PortalLocation | PortalView) => onNavigate(portalPath(to)), [onNavigate]);
  const currentThread = location.view === "chat" ? location.threadId : null;
  /** The thread the chat view shows: the one in the URL, else the last one shown. */
  const [lastThread, setLastThread] = useState(currentThread ?? MAIN_THREAD_ID);
  if (currentThread !== null && currentThread !== lastThread) setLastThread(currentThread);
  const shownThread = currentThread ?? lastThread;
  /** Threads opened this visit stay mounted (hidden) so a reply keeps streaming in the background. */
  const [visited, setVisited] = useState<string[]>([shownThread]);
  if (!visited.includes(shownThread)) setVisited([...visited, shownThread]);
  const [unread, setUnread] = useState<ReadonlySet<string>>(new Set());
  if (currentThread !== null && unread.has(currentThread)) {
    const next = new Set(unread);
    next.delete(currentThread);
    setUnread(next);
  }
  usePortalEvents((event) => {
    if (event.type !== "messages") return;
    const id = event.threadId ?? MAIN_THREAD_ID;
    if (id === currentThread) return;
    setUnread((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  });

  const handlers: Omit<ItemCardHandlers, "onAsk"> = useMemo(
    () => ({
      onOpenSession,
      onPatched: putItem,
      onReviewApproval: requestApproval,
      onOpenMemory: () => go("memory"),
      onOpenCurationRun: (runId: string) => go({ view: "memory", entityId: null, runId }),
    }),
    [onOpenSession, putItem, requestApproval, go],
  );
  /** An item opened from a link (Activity, Goals): its card in a dialog. */
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const openItem = items.find((item) => item.id === openItemId) ?? null;
  const dialogHandlers: ItemCardHandlers = useMemo(
    () => ({
      ...handlers,
      // Outside a conversation, "Ask Portal" drafts into the main thread and goes there.
      onAsk: (text: string) => {
        const key = "portal:orchestrator";
        const current = readDraft(key);
        if (!current.includes(text)) writeDraft(key, current.trim() ? `${current.trimEnd()}\n${text}` : text);
        setOpenItemId(null);
        go({ view: "chat", threadId: MAIN_THREAD_ID });
      },
    }),
    [handlers, go],
  );
  const links = useMemo(
    () => ({
      openThread: (threadId: string) => go({ view: "chat", threadId }),
      openItem: (itemId: string) => setOpenItemId(itemId),
      openSession: onOpenSession,
      openGoals: () => go("goals"),
      openEntity: (entityId: string) => go({ view: "memory", entityId }),
      openCurationRun: (runId: string | null) => go({ view: "memory", entityId: null, runId }),
      openApproval: requestApproval,
    }),
    [go, onOpenSession, requestApproval],
  );

  const threadExists = shownThread === MAIN_THREAD_ID || threads.some((thread) => thread.id === shownThread);

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <AuroraBackground activity={portalActivity(status, approvals)} />
      <header className="workspace-header !items-start max-sm:!items-center">
        <IconButton id="sidebar-toggle" label="Toggle sidebar" onClick={onOpenSidebar} className="text-muted-foreground">
          <PanelLeft className="size-4" />
        </IconButton>
        <div className="min-w-0 flex-1 pt-1.5 max-sm:pt-0">
          <h1 className="text-[13px] font-medium leading-snug tracking-[-.01em]">{viewMeta[view].title}</h1>
          {view === "chat" && <PortalStatusLine onOpenThread={links.openThread} />}
        </div>
      </header>
      {live.error && (
        <p role="alert" className="border-b border-white/5 px-5 py-1.5 text-[11px] text-destructive">
          {live.error}
        </p>
      )}
      <section hidden={view !== "chat"} aria-label="Chat" className="flex min-h-0 flex-1 flex-col">
        <ThreadSwitcher current={shownThread} unread={unread} onSelect={links.openThread} />
        {!threadExists && threads.length > 0 && (
          <p role="alert" className="mx-auto w-full max-w-[840px] px-7 pt-4 text-sm text-destructive">
            Portal has no thread with the id “{shownThread}”.
          </p>
        )}
        {visited.map((threadId) => (
          <PortalThread
            key={threadId}
            threadId={threadId}
            thread={threads.find((thread) => thread.id === threadId) ?? null}
            visible={view === "chat" && threadId === shownThread}
            handlers={handlers}
            onOpenGoals={links.openGoals}
          />
        ))}
      </section>
      {view === "goals" && <GoalsView links={links} />}
      {view === "activity" && <ActivityView links={links} />}
      {view === "memory" && (
        <MemoryView
          entityId={location.view === "memory" ? location.entityId : null}
          runId={location.view === "memory" ? location.runId : undefined}
          onSelectEntity={(id) => go({ view: "memory", entityId: id })}
          onSelectRun={links.openCurationRun}
          links={links}
        />
      )}
      {view === "system" && <SystemView links={links} />}
      <ResponsiveDialog
        open={openItem !== null}
        onOpenChange={(open) => !open && setOpenItemId(null)}
        title="Item"
        description="An action item Portal raised."
      >
        {openItem && <PortalItemCard item={openItem} {...dialogHandlers} />}
      </ResponsiveDialog>
    </main>
  );
}

/** What views hand to links in their rows: threads, items, sessions, goals, memory, and approvals. */
export type PortalLinks = {
  openThread: (threadId: string) => void;
  openItem: (itemId: string) => void;
  openSession: (sessionId: string) => void;
  openGoals: () => void;
  openEntity: (entityId: string) => void;
  /** Memory curation: null lists the runs, an id opens one run's digest and diff. */
  openCurationRun: (runId: string | null) => void;
  openApproval: (approvalId: string) => void;
};
