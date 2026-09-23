"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  Brain,
  ChevronDown,
  ExternalLink,
  FolderGit2,
  GitPullRequest,
  LoaderCircle,
  MessagesSquare,
  ServerCog,
  ShieldQuestion,
  SquareTerminal,
  Target,
  User,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { PortalLinks } from "../PortalPage";
import { At, Empty, ErrorLine, JsonBlock, Loading, ViewBody } from "./bits";
import { usePortalEvents, usePortalLive, useNow } from "./PortalLive";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { activityFilters, activityLinks, describeKind, matchesPrefix, mergeActivity, type ActivityLink } from "@/lib/orchestrator/activity";
import { portalJson, query } from "@/lib/orchestrator/api";
import { relativeTime } from "@/lib/orchestrator/format";
import { MAIN_THREAD_ID, type ActivityActor, type ActivityEntry } from "@/lib/orchestrator/types";

const PAGE = 50;

const actorMeta: Record<ActivityActor, { icon: LucideIcon; label: string }> = {
  user: { icon: User, label: "You" },
  agent: { icon: Bot, label: "Portal" },
  system: { icon: ServerCog, label: "System" },
};

function LinkChip({ link, links, threadTitle }: { link: ActivityLink; links: PortalLinks; threadTitle: (id: string) => string }) {
  const base =
    "inline-flex max-w-full items-center gap-1 rounded-full bg-white/6 px-2 text-[11px] leading-5 text-foreground/80 hover:bg-white/10 hover:text-foreground";
  const chip = (icon: LucideIcon, label: string, onClick: () => void) => {
    const Icon = icon;
    return (
      <button type="button" className={base} onClick={onClick}>
        <Icon className="size-3 shrink-0" />
        <span className="truncate">{label}</span>
      </button>
    );
  };
  switch (link.type) {
    case "thread":
      return chip(MessagesSquare, threadTitle(link.id), () => links.openThread(link.id));
    case "pull":
      return (
        <a href={link.url} target="_blank" rel="noreferrer" className={base}>
          <GitPullRequest className="size-3 shrink-0" />
          <span className="truncate">
            {link.repo}#{link.number}
          </span>
          <ExternalLink className="size-2.5 shrink-0 opacity-60" />
        </a>
      );
    case "session":
      return chip(SquareTerminal, "Session", () => links.openSession(link.id));
    case "item":
      return chip(Zap, "Item", () => links.openItem(link.id));
    case "approval":
      return chip(ShieldQuestion, "Approval", () => links.openApproval(link.id));
    case "intent":
      return chip(Target, "Goal", links.openGoals);
    case "job":
      return chip(Target, "Job", links.openGoals);
    case "record":
      return link.entityId ? chip(Brain, "Memory record", () => links.openEntity(link.entityId!)) : null;
    case "entity":
      return chip(Brain, "Memory", () => links.openEntity(link.id));
    case "project":
      return (
        <span className={base}>
          <FolderGit2 className="size-3 shrink-0" />
          Project
        </span>
      );
    default:
      return null;
  }
}

function EntryRow({
  entry,
  now,
  links,
  threadTitle,
}: {
  entry: ActivityEntry;
  now: number;
  links: PortalLinks;
  threadTitle: (id: string) => string;
}) {
  const actor = actorMeta[entry.actor] ?? actorMeta.system;
  const Icon = actor.icon;
  const refs = activityLinks(entry.refs);
  const hasDetail = !!entry.detail && Object.keys(entry.detail).length > 0;
  return (
    <li className="px-4 py-2.5" data-kind={entry.kind}>
      <Collapsible>
        <div className="flex items-start gap-3">
          <span
            className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full ${entry.actor === "user" ? "bg-white/10" : entry.actor === "agent" ? "bg-sky-300/12 text-sky-200" : "bg-white/5 text-muted-foreground"}`}
            title={actor.label}
          >
            <Icon className="size-3.5" />
            <span className="sr-only">{actor.label}</span>
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] leading-snug text-foreground/90">{entry.summary}</p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="font-mono text-[10px]">{entry.kind}</span>
              <span>·</span>
              <span title={new Date(entry.at).toLocaleString()}>{relativeTime(Math.min(entry.at, now), now)}</span>
              <span className="max-sm:hidden">·</span>
              <span className="max-sm:hidden">
                <At at={entry.at} now={now} />
              </span>
              {refs.map((link, index) => (
                <LinkChip key={index} link={link} links={links} threadTitle={threadTitle} />
              ))}
            </div>
          </div>
          {hasDetail && (
            <CollapsibleTrigger asChild>
              <Button type="button" size="icon-xs" variant="ghost" aria-label="Show details" className="group text-muted-foreground">
                <ChevronDown className="transition-transform group-data-[state=open]:rotate-180" />
              </Button>
            </CollapsibleTrigger>
          )}
        </div>
        {hasDetail && (
          <CollapsibleContent>
            <JsonBlock value={entry.detail} className="mt-2 ml-9" />
          </CollapsibleContent>
        )}
      </Collapsible>
    </li>
  );
}

/**
 * The activity log: everything Portal and the user did to it, newest first, filterable by kind
 * (the server filters by dotted prefix), paged with `before=<id>`, with live `activity` events
 * prepended when they match the filter. Refs become links to threads, items, sessions, PRs, goals,
 * approvals, and memory.
 */
export default function ActivityView({ links }: { links: PortalLinks }) {
  const { threads } = usePortalLive();
  const now = useNow(30_000);
  const [filter, setFilter] = useState(activityFilters[0].id);
  const prefix = activityFilters.find((entry) => entry.id === filter)?.prefix ?? null;
  /** The loaded page, tagged with the filter it is for, so switching filters shows "Loading" until the new one lands. */
  const [page, setPage] = useState<{ prefix: string | null; entries: ActivityEntry[] } | null>(null);
  const [failure, setFailure] = useState<{ prefix: string | null; message: string } | null>(null);
  const entries = page && page.prefix === prefix ? page.entries : null;
  const error = failure && failure.prefix === prefix ? failure.message : null;
  const setEntries = (update: (current: ActivityEntry[]) => ActivityEntry[]) =>
    setPage((prev) => (prev && prev.prefix === prefix ? { prefix, entries: update(prev.entries) } : prev));
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [request, setRequest] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    portalJson<{ entries: ActivityEntry[] }>(`/api/portal/activity${query({ limit: PAGE, kind: prefix })}`, { signal: controller.signal })
      .then(({ entries }) => {
        setPage({ prefix, entries: mergeActivity([], entries) });
        setFailure(null);
        setHasMore(entries.length >= PAGE);
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setFailure({ prefix, message: e instanceof Error ? e.message : "Could not load the activity log." });
      });
    return () => controller.abort();
  }, [prefix, request]);

  usePortalEvents((event) => {
    if (event.type === "reconnected") setRequest((n) => n + 1);
    else if (event.type === "activity" && matchesPrefix(event.entry, prefix))
      setEntries((current) => mergeActivity(current, [event.entry]));
  });

  const loadOlder = async () => {
    const last = entries?.at(-1);
    if (!last) return;
    setLoadingOlder(true);
    try {
      const { entries: older } = await portalJson<{ entries: ActivityEntry[] }>(
        `/api/portal/activity${query({ before: last.id, limit: PAGE, kind: prefix })}`,
      );
      setEntries((current) => mergeActivity(current, older));
      setHasMore(older.length >= PAGE);
    } catch (e) {
      setFailure({ prefix, message: e instanceof Error ? e.message : "Could not load older entries." });
    } finally {
      setLoadingOlder(false);
    }
  };

  const titles = useMemo(() => new Map(threads.map((thread) => [thread.id, thread.title])), [threads]);
  const threadTitle = (id: string) => (id === MAIN_THREAD_ID ? "Main thread" : titles.get(id) ?? "Thread");

  return (
    <ViewBody label="Activity">
      <div>
        <div role="group" aria-label="Filter by kind" className="-mx-1 mb-3 flex flex-wrap gap-1">
          {activityFilters.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={entry.id === filter}
              onClick={() => setFilter(entry.id)}
              className={`h-7 rounded-full px-3 text-xs transition-colors ${
                entry.id === filter ? "bg-white/12 text-foreground" : "text-muted-foreground hover:bg-white/6 hover:text-foreground"
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <ErrorLine>{error}</ErrorLine>
        {!entries && !error && <Loading>Loading the log…</Loading>}
        {entries && entries.length === 0 && (
          <Empty>{prefix ? `Nothing under “${describeKind(prefix.replace(/\.$/, ""))}” yet.` : "Nothing has happened yet."}</Empty>
        )}
        {entries && entries.length > 0 && (
          <ol aria-label="Activity log" className="divide-y divide-white/5 rounded-2xl border border-white/8 bg-white/[.02]">
            {entries.map((entry) => (
              <EntryRow key={entry.id} entry={entry} now={now} links={links} threadTitle={threadTitle} />
            ))}
          </ol>
        )}
        {hasMore && entries && (
          <Button type="button" variant="ghost" size="sm" disabled={loadingOlder} onClick={() => void loadOlder()} className="mt-2 text-xs text-muted-foreground">
            {loadingOlder && <LoaderCircle className="animate-spin" />}
            Load older
          </Button>
        )}
      </div>
    </ViewBody>
  );
}
