"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Brain,
  LoaderCircle,
  MessagesSquare,
  PanelLeft,
  Play,
  ServerCog,
  Target,
  type LucideIcon,
} from "lucide-react";
import IconButton from "./IconButton";
import PortalItemCard, { type ItemCardHandlers } from "./PortalItemCard";
import { formatTime } from "./PortalMessage";
import ResponsiveDialog from "./ResponsiveDialog";
import ActivityView from "./portal/ActivityView";
import GoalsView from "./portal/GoalsView";
import MemoryView from "./portal/MemoryView";
import PortalStatusLine from "./portal/PortalStatusLine";
import PortalThread from "./portal/PortalThread";
import SystemView from "./portal/SystemView";
import ThreadSwitcher from "./portal/ThreadSwitcher";
import { usePortalEvents, usePortalLive } from "./portal/PortalLive";
import { Button } from "@/components/ui/button";
import { readDraft, writeDraft } from "@/lib/drafts";
import { portalJson } from "@/lib/orchestrator/api";
import { MAIN_THREAD_ID, type TickReport } from "@/lib/orchestrator/types";
import { portalLocation, portalPath, type PortalLocation, type PortalView } from "@/lib/session-routes";

/** "Checked at 10:42 · 2 changes, 1 new item" for the inline tick line. */
function describeTick(report: TickReport): string {
  const when = `Checked at ${formatTime(report.finishedAt)}`;
  if (report.error) return `${when} · failed: ${report.error}`;
  if (!report.modelInvoked) return `${when} · nothing new`;
  const parts = [`${report.changes} ${report.changes === 1 ? "change" : "changes"}`];
  if (report.itemsCreated.length) parts.push(`${report.itemsCreated.length} new`);
  if (report.itemsUpdated.length) parts.push(`${report.itemsUpdated.length} updated`);
  if (report.itemsResolved.length) parts.push(`${report.itemsResolved.length} resolved`);
  return `${when} · ${parts.join(", ")}`;
}

const viewMeta: Record<PortalView, { label: string; icon: LucideIcon }> = {
  chat: { label: "Chat", icon: MessagesSquare },
  goals: { label: "Goals", icon: Target },
  activity: { label: "Activity", icon: Activity },
  memory: { label: "Memory", icon: Brain },
  system: { label: "System", icon: ServerCog },
};
const views: PortalView[] = ["chat", "goals", "activity", "memory", "system"];

/**
 * Talk to Portal: the orchestrator's page. The header carries the live status line and the view
 * tabs; Chat holds the main thread and the side threads Portal opened (each its own conversation),
 * Goals the intents, upcoming jobs, and recent runs, Activity the audit log, Memory the curated
 * records, and System what the model is shown (CORE.md, the world) plus approval grants. The URL
 * says which (`/portal/**`), so reloads and links land in place.
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
  const { status, threads, lastTick, putItem, noteTick, requestApproval, items } = live;
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

  const ready = status?.ready ?? false;

  // The inline tick line shows for a few seconds, then leaves the header alone.
  const [expiredTickAt, setExpiredTickAt] = useState<number | null>(null);
  useEffect(() => {
    if (!lastTick) return;
    const timer = setTimeout(() => setExpiredTickAt(lastTick.at), 8000);
    return () => clearTimeout(timer);
  }, [lastTick]);
  const tickNotice = lastTick && expiredTickAt !== lastTick.at ? lastTick.report : null;

  const [ticking, setTicking] = useState(false);
  const [tickError, setTickError] = useState<string | null>(null);
  const runNow = async () => {
    setTicking(true);
    setTickError(null);
    try {
      const { report } = await portalJson<{ report: TickReport }>(
        "/api/portal/tick",
        { method: "POST" },
        "Could not run a check. Try again.",
      );
      noteTick(report);
    } catch (e) {
      setTickError(e instanceof Error ? e.message : "Could not run a check. Try again.");
    } finally {
      setTicking(false);
    }
  };

  const handlers: Omit<ItemCardHandlers, "onAsk"> = useMemo(
    () => ({ onOpenSession, onPatched: putItem, onReviewApproval: requestApproval }),
    [onOpenSession, putItem, requestApproval],
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
      openApproval: requestApproval,
    }),
    [go, onOpenSession, requestApproval],
  );

  const counts = status?.counts;
  const badge: Partial<Record<PortalView, number>> = {
    chat: counts?.needsYou,
    goals: counts?.intents,
    memory: counts?.inbox,
  };
  const threadExists = shownThread === MAIN_THREAD_ID || threads.some((thread) => thread.id === shownThread);

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="workspace-header !items-start max-sm:!items-center">
        <IconButton id="sidebar-toggle" label="Toggle sidebar" onClick={onOpenSidebar} className="text-muted-foreground">
          <PanelLeft className="size-4" />
        </IconButton>
        <div className="min-w-0 flex-1 pt-1.5 max-sm:pt-0">
          <h1 className="text-[13px] font-medium leading-snug tracking-[-.01em]">Talk to Portal</h1>
          <PortalStatusLine onOpenThread={links.openThread} />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!ready || ticking}
          onClick={() => void runNow()}
          className="mt-1.5 text-xs text-foreground/80 max-sm:mt-0"
        >
          {ticking ? <LoaderCircle className="animate-spin" /> : <Play />}
          Run now
        </Button>
      </header>
      <nav aria-label="Portal views" className="border-b border-white/5">
        <div className="flex items-center gap-0.5 overflow-x-auto px-4 [scrollbar-width:none] max-sm:px-2">
          {views.map((entry) => {
            const Icon = viewMeta[entry].icon;
            const selected = entry === view;
            const count = badge[entry];
            return (
              <button
                key={entry}
                type="button"
                aria-current={selected ? "page" : undefined}
                onClick={() => go(entry === "chat" ? { view: "chat", threadId: shownThread } : entry)}
                className={`relative flex h-9 shrink-0 items-center gap-1.5 px-2.5 text-xs transition-colors ${
                  selected ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="size-3.5" />
                {viewMeta[entry].label}
                {!!count && (
                  <span
                    className={`rounded-full px-1.5 text-[10px] leading-4 ${entry === "chat" ? "bg-amber-300/15 text-amber-200" : "bg-white/10 text-foreground/80"}`}
                  >
                    <span className="sr-only">(</span>
                    {count}
                    <span className="sr-only">)</span>
                  </span>
                )}
                {selected && <span className="absolute inset-x-2 -bottom-px h-px bg-foreground/70" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      </nav>
      {(tickNotice || tickError || live.error) && (
        <p
          role={tickError || live.error ? "alert" : "status"}
          className={`border-b border-white/5 px-5 py-1.5 text-[11px] ${tickError || live.error ? "text-destructive" : "text-muted-foreground"}`}
        >
          {tickError ?? live.error ?? (tickNotice && describeTick(tickNotice))}
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
        <MemoryView entityId={location.view === "memory" ? location.entityId : null} onSelectEntity={(id) => go({ view: "memory", entityId: id })} links={links} />
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
  openApproval: (approvalId: string) => void;
};
