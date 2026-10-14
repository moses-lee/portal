import { cn } from "@/lib/utils";
import { sessionStateLabels, type SessionState } from "@/lib/session-state";

const badgeTone: Record<SessionState, string> = {
  approval: "bg-amber-300/15 text-amber-200",
  finished: "bg-sky-300/15 text-sky-200",
  working: "bg-emerald-400/15 text-emerald-200",
  background: "bg-violet-400/15 text-violet-200",
  connecting: "bg-blue-300/10 text-blue-200/80",
  offline: "bg-destructive/15 text-red-200",
  hung: "bg-destructive/15 text-red-200",
};

/** A session's live state, including its background task count when available. */
export default function SessionStateBadge({ state, tasks = 0, className }: { state: SessionState; tasks?: number; className?: string }) {
  const count = state === "background" && tasks > 0 ? tasks : 0;
  return (
    <span
      data-state={state}
      title={count ? `${count} background ${count === 1 ? "task" : "tasks"} running` : undefined}
      className={cn("shrink-0 rounded-full px-1.5 text-[10px] font-medium leading-4 whitespace-nowrap", badgeTone[state], className)}
    >
      {sessionStateLabels[state]}
      {count > 0 && ` · ${count}`}
    </span>
  );
}
