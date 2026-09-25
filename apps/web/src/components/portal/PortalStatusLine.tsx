"use client";

import { Activity, LoaderCircle, ShieldAlert } from "lucide-react";
import { usePortalLive, useNow } from "./PortalLive";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { describeStatusLine, runDuration } from "@/lib/orchestrator/format";
import { MAIN_THREAD_ID } from "@/lib/orchestrator/types";

const runKindLabels: Record<string, string> = {
  chat: "Chat turn",
  intent_check: "Goal check",
  helper: "Helper",
  consolidate: "Memory curation",
};

/**
 * The always-visible status line under the page title: the server's `line` (what runs, else what
 * comes next) with the next job's time counted down here. While anything runs, it opens a list of
 * the runs; when approvals wait, a pill brings the approvals dialog back.
 */
export default function PortalStatusLine({ onOpenThread }: { onOpenThread: (threadId: string) => void }) {
  const { status, threads, approvals, requestApproval } = usePortalLive();
  const now = useNow(15_000);
  const { line, next, tone } = describeStatusLine(status, now);
  const runs = status?.runs ?? [];
  const titleOf = (threadId: string | null) =>
    threadId === null || threadId === MAIN_THREAD_ID
      ? "Main thread"
      : threads.find((thread) => thread.id === threadId)?.title ?? "Side thread";
  const text = (
    <>
      {/* On narrow screens the countdown gives way first, so the line stays readable. */}
      <span className="min-w-0 truncate">{line}</span>
      {next && <span className="min-w-0 shrink-[4] truncate text-muted-foreground/80">· {next}</span>}
    </>
  );
  return (
    <div className="mt-1 flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground" aria-live="polite" data-testid="portal-status-line">
      {tone === "running" ? (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={`Status: ${line}${next ? ` · ${next}` : ""}. Show running work`}
              className="flex min-w-0 items-center gap-1.5 rounded-md text-left text-foreground/85 hover:text-foreground"
            >
              <LoaderCircle className="size-3 shrink-0 animate-spin text-sky-300" />
              {text}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80">
            <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Running now ({runs.length})
            </p>
            <ul className="space-y-2">
              {runs.map((run) => (
                <li key={run.id} className="flex items-start gap-2 text-xs">
                  <Activity className="mt-0.5 size-3.5 shrink-0 text-sky-300" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate">{run.summary ?? runKindLabels[run.kind] ?? run.kind}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {runKindLabels[run.kind] ?? run.kind} · {runDuration({ startedAt: run.startedAt, finishedAt: null }, now)}
                      {run.threadId && (
                        <>
                          {" · "}
                          <button
                            type="button"
                            className="underline-offset-2 hover:text-foreground hover:underline"
                            onClick={() => onOpenThread(run.threadId!)}
                          >
                            {titleOf(run.threadId)}
                          </button>
                        </>
                      )}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      ) : (
        <p className={`flex min-w-0 items-center gap-1.5 ${tone === "paused" ? "text-amber-200/90" : ""}`}>
          <span
            aria-hidden="true"
            className={`size-1.5 shrink-0 rounded-full ${tone === "idle" ? "bg-emerald-400/80" : tone === "paused" ? "bg-amber-300" : "bg-white/30"}`}
          />
          {text}
        </p>
      )}
      {approvals.length > 0 && (
        <button
          type="button"
          onClick={() => requestApproval(approvals[0].id)}
          className="ml-auto flex shrink-0 items-center gap-1 rounded-full bg-amber-300/15 px-2 leading-5 font-medium text-amber-200 hover:bg-amber-300/25"
        >
          <ShieldAlert className="size-3" />
          {approvals.length === 1 ? "1 approval waiting" : `${approvals.length} approvals waiting`}
        </button>
      )}
    </div>
  );
}
