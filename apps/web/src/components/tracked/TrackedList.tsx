"use client";

import { memo, useId } from "react";
import AgentLogo from "../AgentLogo";
import { useNow } from "../portal/PortalLive";
import { useSettings } from "../useSettings";
import { relativeAge } from "@/lib/relative-age";
import { untrackCountdown } from "@/lib/session-lifecycle";
import { defaultSettings } from "@/lib/settings";
import type { TrackedGroup, TrackedRow as Row } from "@/lib/tracked-sessions";
import { TrackedRowMenu, TrackedStateBadge, backgroundTaskCount, trackedTitle, type TrackedRowActions } from "./parts";

/**
 * One tracked session. Memoised: the list re-renders on every live change to any session, and the
 * provider keeps an unchanged session's object, so only the changed row renders.
 */
const TrackedRow = memo(function TrackedRow({
  session,
  state,
  trackedAt,
  now,
  untrackAfterHours,
  onSelect,
  actions,
}: {
  session: Row["session"];
  state: Row["state"];
  /** When it was tracked: its untrack clock starts no earlier. */
  trackedAt: number;
  now: number;
  /** The sweep's rule 1 clock, for a finished row's "untracks in …". */
  untrackAfterHours: number;
  onSelect: (sessionId: string) => void;
  actions: TrackedRowActions;
}) {
  const id = useId();
  const title = trackedTitle(session);
  const age = relativeAge(now - session.lastActiveAt);
  // Only finished rows count down: anything else is doing something, so no idle clock runs.
  const untracks = state === "finished" ? untrackCountdown(session, untrackAfterHours, now, trackedAt) : null;
  return (
    <li className="group flex items-start gap-0.5 rounded-xl hover:bg-white/5" data-session-id={session.id}>
      <button
        type="button"
        aria-labelledby={`${id}-title`}
        aria-describedby={untracks ? `${id}-state ${id}-meta ${id}-untracks` : `${id}-state ${id}-meta`}
        onClick={() => onSelect(session.id)}
        className="flex min-w-0 flex-1 items-start gap-2.5 rounded-xl py-1.5 pl-2.5 text-left"
      >
        <AgentLogo agentId={session.agentId} className="mt-0.5 !size-[14px] opacity-80" />
        <span className="min-w-0 flex-1">
          <span id={`${id}-title`} className="block truncate text-[13px] leading-5 text-foreground/90">
            {title}
          </span>
          <span
            id={`${id}-meta`}
            className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-muted-foreground"
          >
            <span className="min-w-0 truncate">{session.project?.name ?? "No project"}</span>
            <span aria-hidden="true">·</span>
            <span className="shrink-0">{age === "now" ? "just now" : `${age} ago`}</span>
          </span>
          {untracks && (
            <span id={`${id}-untracks`} data-testid="tracked-untracks" className="mt-0.5 block text-[11px] leading-4 text-muted-foreground/75">
              {untracks}
            </span>
          )}
        </span>
        <span id={`${id}-state`} className="mt-0.5 shrink-0">
          <TrackedStateBadge state={state} tasks={backgroundTaskCount(session)} />
        </span>
      </button>
      <TrackedRowMenu
        session={session}
        state={state}
        actions={actions}
        className="mt-1.5 mr-1 opacity-60 group-hover:opacity-100 focus-visible:opacity-100"
      />
    </li>
  );
});

/** The panel's list mode body: the tracked sessions in their groups, or the empty state. */
export default function TrackedList({
  id,
  groups,
  loading,
  onSelect,
  actions,
}: {
  id?: string;
  groups: TrackedGroup[];
  /** True until the session list has loaded: rows cannot be built yet, and "nothing tracked" would be a lie. */
  loading: boolean;
  /** Show one session in the panel (sets `?session=`). */
  onSelect: (sessionId: string) => void;
  actions: TrackedRowActions;
}) {
  const now = useNow(60_000);
  const { settings } = useSettings();
  const untrackAfterHours = (settings ?? defaultSettings).sessions.tracked.untrackAfterHours;
  if (groups.length === 0)
    return (
      <p id={id} className="px-4 py-4 text-xs leading-relaxed text-muted-foreground">
        {loading
          ? "Loading…"
          : "Nothing is tracked yet. Portal tracks the sessions it starts for you, and every session page has a Track button in its header."}
      </p>
    );
  return (
    <div id={id} className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
      {groups.map((group) => (
        <section key={group.id} aria-label={group.label} data-group={group.id}>
          <h3 className="px-2.5 pt-3 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            {group.label}
          </h3>
          <ul className="space-y-0.5">
            {group.rows.map((row) => (
              <TrackedRow key={row.session.id} session={row.session} state={row.state} trackedAt={row.tracked.trackedAt} now={now} untrackAfterHours={untrackAfterHours} onSelect={onSelect} actions={actions} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
