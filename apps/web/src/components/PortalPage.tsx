"use client";

import { useCallback, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { LoaderCircle, PanelLeft, X } from "lucide-react";
import IconButton from "./IconButton";
import PortalItemCard, { type ItemCardHandlers } from "./PortalItemCard";
import ResponsiveDialog from "./ResponsiveDialog";
import { agentDraftKey } from "@/lib/orchestrator/drafts";
import { usePortalLive } from "./portal/PortalLive";
import { viewMeta } from "./portal/views";
import { readDraft, writeDraft } from "@/lib/drafts";
import { portalPath, type PortalLocation, type PortalView } from "@/lib/session-routes";
import type { ProjectSummary } from "@/lib/types";
import type { RemoveProjectOptions } from "./useProjects";

function ViewLoading() {
  return <div className="flex flex-1 items-center justify-center text-muted-foreground"><LoaderCircle className="size-4 animate-spin" /></div>;
}
const AttentionView = dynamic(() => import("./portal/AttentionView"), { loading: ViewLoading });
const WatchesView = dynamic(() => import("./portal/WatchesView"), { loading: ViewLoading });
const ActivityView = dynamic(() => import("./portal/ActivityView"), { loading: ViewLoading });
const MemoryView = dynamic(() => import("./portal/MemoryView"), { loading: ViewLoading });
const SystemView = dynamic(() => import("./portal/SystemView"), { loading: ViewLoading });
const MonitoringView = dynamic(() => import("./portal/MonitoringView"), { loading: ViewLoading });

/** A page over the mounted workspace. Its location is local UI state, never the browser URL. */
export default function PortalPage({ location, onNavigate, onOpenSidebar, onOpenSession, onClose, projects, onRemoveProject }: {
  location: Exclude<PortalLocation, { view: "chat" }>;
  onNavigate: (path: string) => void;
  onOpenSidebar: (opener?: HTMLElement | null) => void;
  onOpenSession: (sessionId: string) => void;
  onClose: () => void;
  /** The listed projects and the sidebar's removal path, for Monitoring's "Remove worktree". */
  projects: ProjectSummary[];
  onRemoveProject: (id: string, opts?: RemoveProjectOptions) => Promise<void>;
}) {
  const { putItem, requestApproval, items, error } = usePortalLive();
  const view = location.view;
  const go = useCallback((to: PortalLocation | PortalView) => onNavigate(portalPath(to)), [onNavigate]);
  const handlers = useMemo<Omit<ItemCardHandlers, "onAsk">>(() => ({
    onOpenSession,
    onPatched: putItem,
    onReviewApproval: requestApproval,
    onOpenMemory: () => go("memory"),
    onOpenCurationRun: (runId) => go({ view: "memory", entityId: null, runId }),
  }), [onOpenSession, putItem, requestApproval, go]);
  const askAgent = useCallback((text: string) => {
    const current = readDraft(agentDraftKey);
    if (!current.includes(text)) writeDraft(agentDraftKey, current.trim() ? `${current.trimEnd()}\n${text}` : text);
    go("chat");
  }, [go]);
  const pageHandlers = useMemo<ItemCardHandlers>(() => ({ ...handlers, onAsk: askAgent }), [handlers, askAgent]);
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const openItem = items.find((item) => item.id === openItemId) ?? null;
  const dialogHandlers = useMemo<ItemCardHandlers>(() => ({
    ...pageHandlers,
    onOpenSession: (id) => { setOpenItemId(null); onOpenSession(id); },
    onAsk: (text) => { setOpenItemId(null); askAgent(text); },
  }), [pageHandlers, askAgent, onOpenSession]);
  const links = useMemo<PortalLinks>(() => ({
    openItem: setOpenItemId,
    openSession: onOpenSession,
    openWatches: () => go("watches"),
    openEntity: (entityId) => go({ view: "memory", entityId }),
    openCurationRun: (runId) => go({ view: "memory", entityId: null, runId }),
    openApproval: requestApproval,
  }), [go, onOpenSession, requestApproval]);

  return <main className="flex min-h-0 min-w-0 flex-1 flex-col">
    <header className="workspace-header">
      <IconButton label="Toggle sidebar" onClick={(event) => onOpenSidebar(event.currentTarget)} className="text-muted-foreground"><PanelLeft className="size-4" /></IconButton>
      <h1 className="min-w-0 flex-1 text-[13px] font-medium">{viewMeta[view].title}</h1>
      <IconButton label="Close page" onClick={onClose} className="text-muted-foreground"><X className="size-4" /></IconButton>
    </header>
    {error && <p role="alert" className="border-b border-white/5 px-5 py-1.5 text-[11px] text-destructive">{error}</p>}
    {view === "attention" && <AttentionView links={links} handlers={pageHandlers} />}
    {view === "watches" && <WatchesView links={links} />}
    {view === "activity" && <ActivityView links={links} />}
    {view === "memory" && <MemoryView entityId={location.entityId} runId={location.runId} onSelectEntity={(entityId) => go({ view: "memory", entityId })} onSelectRun={links.openCurationRun} links={links} />}
    {view === "system" && <SystemView links={links} />}
    {view === "monitoring" && <MonitoringView links={links} projects={projects} onRemoveProject={onRemoveProject} />}
    <ResponsiveDialog open={openItem !== null} onOpenChange={(open) => !open && setOpenItemId(null)} title="Item" description="An action item Portal raised.">
      {openItem && <PortalItemCard item={openItem} {...dialogHandlers} />}
    </ResponsiveDialog>
  </main>;
}

/** What views hand to links in their rows: items, sessions, watches, memory, and approvals. */
export type PortalLinks = {
  openItem: (itemId: string) => void;
  openSession: (sessionId: string) => void;
  openWatches: () => void;
  openEntity: (entityId: string) => void;
  /** Memory curation: null lists the runs, an id opens one run's digest and diff. */
  openCurationRun: (runId: string | null) => void;
  openApproval: (approvalId: string) => void;
};
