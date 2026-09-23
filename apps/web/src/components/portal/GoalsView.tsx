"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Ban,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  CirclePause,
  Clock,
  LoaderCircle,
  MessagesSquare,
  Pause,
  Play,
  ShieldQuestion,
  Target,
  X,
  Zap,
} from "lucide-react";
import PortalMarkdown from "../PortalMarkdown";
import type { PortalLinks } from "../PortalPage";
import { Badge, Empty, ErrorLine, JsonBlock, Loading, SectionTitle, ViewBody, When, type Tone } from "./bits";
import { usePortalEvents, usePortalLive, useNow } from "./PortalLive";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { portalJson, portalSend, query } from "@/lib/orchestrator/api";
import { describeSchedule, describeUsage, formatDuration, runDuration } from "@/lib/orchestrator/format";
import type { Intent, Job, JobKind, JobRun, RunStatus } from "@/lib/orchestrator/types";

const jobKindLabels: Record<JobKind | "chat", string> = {
  tick: "Check",
  intent_check: "Goal check",
  helper: "Helper",
  consolidate: "Curation",
  chat: "Chat turn",
};

const runStatusMeta: Record<RunStatus, { label: string; tone: Tone }> = {
  running: { label: "Running", tone: "sky" },
  succeeded: { label: "Succeeded", tone: "emerald" },
  failed: { label: "Failed", tone: "rose" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  awaiting_approval: { label: "Awaiting approval", tone: "amber" },
};

function RunStatusIcon({ status }: { status: RunStatus }) {
  switch (status) {
    case "running":
      return <LoaderCircle className="size-3.5 animate-spin text-sky-300" />;
    case "succeeded":
      return <CheckCircle2 className="size-3.5 text-emerald-300" />;
    case "failed":
      return <CircleAlert className="size-3.5 text-rose-300" />;
    case "awaiting_approval":
      return <ShieldQuestion className="size-3.5 text-amber-300" />;
    default:
      return <Ban className="size-3.5 text-muted-foreground" />;
  }
}

/** Runs one row action at a time, keeping its error on the row. */
function useRowAction() {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (name: string, action: () => Promise<unknown>) => {
    setPending(name);
    setError(null);
    try {
      await action();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work. Try again.");
      return false;
    } finally {
      setPending(null);
    }
  };
  return { pending, error, run };
}

/** A second click confirms: the first turns the button into "Confirm …". */
function ConfirmButton({
  label,
  confirmLabel,
  disabled,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <Button
      type="button"
      size="xs"
      variant={armed ? "destructive" : "ghost"}
      disabled={disabled}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else setArmed(true);
      }}
      className={armed ? "" : "text-muted-foreground"}
    >
      <X />
      {armed ? confirmLabel : label}
    </Button>
  );
}

function IntentCard({ intent, now, links }: { intent: Intent; now: number; links: PortalLinks }) {
  const { putIntent } = usePortalLive();
  const { pending, error, run } = useRowAction();
  const cancel = () =>
    run("cancel", async () => {
      const { intent: updated } = await portalSend<{ intent: Intent }>(
        `/api/portal/intents/${encodeURIComponent(intent.id)}`,
        "PATCH",
        { status: "cancelled" },
      );
      putIntent(updated);
    });
  const fires = intent.fireBudget === null ? `${intent.fires} fired` : `${intent.fires} of ${intent.fireBudget} fired`;
  return (
    <article aria-label={intent.text} className="glass rounded-2xl p-4 text-[13px]">
      <div className="flex items-start gap-3">
        <Target className="mt-0.5 size-4 shrink-0 text-sky-300" />
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-medium leading-snug tracking-[-.01em]">{intent.text}</h3>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">When</dt>
            <dd className="text-foreground/85">{intent.trigger}</dd>
            <dt className="text-muted-foreground">Then</dt>
            <dd className="text-foreground/85">{intent.action}</dd>
          </dl>
          <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            <span>{fires}</span>
            <span>·</span>
            <span>
              {intent.lastCheckedAt ? <When at={intent.lastCheckedAt} now={now} prefix="checked" past /> : "not checked yet"}
            </span>
            {intent.lastFiredAt && (
              <>
                <span>·</span>
                <When at={intent.lastFiredAt} now={now} prefix="last fired" past />
              </>
            )}
            {intent.expiresAt && (
              <>
                <span>·</span>
                <When at={intent.expiresAt} now={now} prefix={intent.expiresAt > now ? "expires" : "expired"} />
              </>
            )}
            {intent.cooldownMs > 0 && (
              <>
                <span>·</span>
                <span>at most every {formatDuration(intent.cooldownMs)}</span>
              </>
            )}
          </p>
          {intent.notes && (
            <Collapsible className="mt-2">
              <CollapsibleTrigger className="group flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
                Portal’s notes
                <ChevronDown className="size-3 transition-transform group-data-[state=open]:rotate-180" />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-2 border-l border-white/10 pl-3 text-foreground/85">
                  <PortalMarkdown text={intent.notes} compact />
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-1">
            {intent.threadId && (
              <Button type="button" size="xs" variant="ghost" onClick={() => links.openThread(intent.threadId!)} className="text-muted-foreground">
                <MessagesSquare />
                Open thread
              </Button>
            )}
            <ConfirmButton label="Cancel goal" confirmLabel="Confirm cancel" disabled={pending !== null} onConfirm={() => void cancel()} />
            {pending && <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />}
          </div>
          <ErrorLine>{error}</ErrorLine>
        </div>
      </div>
    </article>
  );
}

function JobRow({
  job,
  intent,
  now,
  links,
  onChanged,
}: {
  job: Job;
  intent: Intent | undefined;
  now: number;
  links: PortalLinks;
  onChanged: (job: Job) => void;
}) {
  const { pending, error, run } = useRowAction();
  const [notice, setNotice] = useState<string | null>(null);
  const path = `/api/portal/jobs/${encodeURIComponent(job.id)}`;
  const patch = (name: string, status: Job["status"]) =>
    run(name, async () => {
      const { job: updated } = await portalSend<{ job: Job }>(path, "PATCH", { status });
      onChanged(updated);
    });
  const runNow = () =>
    run("run", async () => {
      await portalSend<{ run: JobRun }>(`${path}/run`, "POST");
      setNotice("Started");
      setTimeout(() => setNotice(null), 2500);
    });
  const paused = job.status === "paused";
  return (
    <li aria-label={job.title} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-[13px] font-medium">{job.title}</span>
          <Badge>{jobKindLabels[job.kind]}</Badge>
          {paused && <Badge tone="amber">Paused</Badge>}
          {job.failures > 0 && <Badge tone="rose">{job.failures} failed</Badge>}
        </div>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
          <span>{describeSchedule(job.schedule, now)}</span>
          <span>·</span>
          <span className={paused ? "" : "text-foreground/80"}>
            {paused ? (
              "not scheduled while paused"
            ) : job.nextRunAt === null ? (
              "not scheduled"
            ) : job.nextRunAt <= now ? (
              "due now"
            ) : (
              <When at={job.nextRunAt} now={now} prefix="next" />
            )}
          </span>
          {job.lastRunAt && (
            <>
              <span>·</span>
              <When at={job.lastRunAt} now={now} prefix="last ran" past />
            </>
          )}
          {intent && (
            <>
              <span>·</span>
              <button type="button" onClick={links.openGoals} className="truncate hover:text-foreground">
                for “{intent.text}”
              </button>
            </>
          )}
          {job.threadId && (
            <>
              <span>·</span>
              <button type="button" onClick={() => links.openThread(job.threadId!)} className="hover:text-foreground hover:underline">
                reports to a thread
              </button>
            </>
          )}
        </p>
        <ErrorLine>{error}</ErrorLine>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {notice && (
          <span role="status" className="mr-1 text-[11px] text-muted-foreground">
            {notice}
          </span>
        )}
        <Button type="button" size="xs" variant="ghost" disabled={pending !== null} onClick={() => void runNow()} aria-label={`Run ${job.title} now`}>
          {pending === "run" ? <LoaderCircle className="animate-spin" /> : <Zap />}
          Run now
        </Button>
        {paused ? (
          <Button type="button" size="xs" variant="ghost" disabled={pending !== null} onClick={() => void patch("resume", "active")} aria-label={`Resume ${job.title}`}>
            {pending === "resume" ? <LoaderCircle className="animate-spin" /> : <Play />}
            Resume
          </Button>
        ) : (
          <Button type="button" size="xs" variant="ghost" disabled={pending !== null} onClick={() => void patch("pause", "paused")} aria-label={`Pause ${job.title}`}>
            {pending === "pause" ? <LoaderCircle className="animate-spin" /> : <Pause />}
            Pause
          </Button>
        )}
        <ConfirmButton label="Cancel" confirmLabel="Confirm cancel" disabled={pending !== null} onConfirm={() => void patch("cancel", "cancelled")} />
      </div>
    </li>
  );
}

function RunRow({ run, title, now, links }: { run: JobRun; title: string; now: number; links: PortalLinks }) {
  const [open, setOpen] = useState(false);
  const { pending, error, run: act } = useRowAction();
  const meta = runStatusMeta[run.status];
  const details = run.log.length > 0 || run.error || run.result;
  return (
    <li aria-label={`Run: ${title}`} className="px-4 py-3">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5">
            <RunStatusIcon status={run.status} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-[13px] font-medium">{title}</span>
              <Badge tone={meta.tone}>{meta.label}</Badge>
            </div>
            {run.summary && <p className="mt-0.5 text-xs leading-relaxed text-foreground/80">{run.summary}</p>}
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
              <When at={run.startedAt} now={now} past />
              <span>·</span>
              <span>
                <Clock className="mr-0.5 inline size-3 -translate-y-px" />
                {runDuration(run, now)}
              </span>
              <span>·</span>
              <span>{run.model ? `${run.model.provider} · ${run.model.model}` : "no model call"}</span>
              {run.usage && (
                <>
                  <span>·</span>
                  <span>{describeUsage(run.usage)}</span>
                </>
              )}
              <span>·</span>
              <span>{run.trigger}</span>
              {run.threadId && (
                <>
                  <span>·</span>
                  <button type="button" onClick={() => links.openThread(run.threadId!)} className="hover:text-foreground hover:underline">
                    thread
                  </button>
                </>
              )}
            </p>
            {run.error && <p className="mt-1 text-xs text-destructive">{run.error}</p>}
            <ErrorLine>{error}</ErrorLine>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {run.status === "running" && run.kind !== "chat" && (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={pending !== null}
                onClick={() => void act("cancel", () => portalSend(`/api/portal/runs/${encodeURIComponent(run.id)}/cancel`, "POST"))}
                className="text-muted-foreground"
              >
                {pending ? <LoaderCircle className="animate-spin" /> : <CirclePause />}
                Stop
              </Button>
            )}
            {details && (
              <CollapsibleTrigger asChild>
                <Button type="button" size="icon-xs" variant="ghost" aria-label={open ? "Hide run details" : "Show run details"} className="text-muted-foreground">
                  <ChevronDown className={`transition-transform ${open ? "rotate-180" : ""}`} />
                </Button>
              </CollapsibleTrigger>
            )}
          </div>
        </div>
        <CollapsibleContent>
          <div className="mt-2 space-y-2 pl-6">
            {run.log.length > 0 && (
              <ol className="space-y-0.5 border-l border-white/10 pl-3 text-[11px] leading-relaxed text-muted-foreground">
                {run.log.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ol>
            )}
            {run.result && <JsonBlock label="Result" value={run.result} />}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

const RUN_PAGE = 20;

/**
 * Goals and upcoming work: the active intents (what the user asked Portal to keep doing), the jobs
 * it scheduled ordered by next run with pause/resume/cancel/run now, and the recent runs with
 * their model, tokens, and duration. Jobs refetch on `jobs` events; runs update from `run` events.
 */
export default function GoalsView({ links }: { links: PortalLinks }) {
  const { intents } = usePortalLive();
  const now = useNow(15_000);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [runs, setRuns] = useState<JobRun[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [moreRuns, setMoreRuns] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [jobsRequest, setJobsRequest] = useState(0);
  const [runsRequest, setRunsRequest] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    // Upcoming shows what is scheduled and what the user paused (so it can be resumed).
    Promise.all([
      portalJson<{ jobs: Job[] }>(`/api/portal/jobs${query({ status: "active" })}`, { signal }),
      portalJson<{ jobs: Job[] }>(`/api/portal/jobs${query({ status: "paused" })}`, { signal }),
    ])
      .then(([active, paused]) => {
        const byId = new Map([...active.jobs, ...paused.jobs].map((job) => [job.id, job]));
        setJobs([...byId.values()]);
        setJobsError(null);
      })
      .catch((e) => {
        if (!signal.aborted) setJobsError(e instanceof Error ? e.message : "Could not load the upcoming jobs.");
      });
    return () => controller.abort();
  }, [jobsRequest]);

  useEffect(() => {
    const controller = new AbortController();
    portalJson<{ runs: JobRun[] }>(`/api/portal/runs${query({ limit: RUN_PAGE })}`, { signal: controller.signal })
      .then(({ runs }) => {
        setRuns(runs);
        setMoreRuns(runs.length >= RUN_PAGE);
        setRunsError(null);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setRunsError(e instanceof Error ? e.message : "Could not load the recent runs.");
      });
    return () => controller.abort();
  }, [runsRequest]);

  usePortalEvents((event) => {
    if (event.type === "jobs") setJobsRequest((n) => n + 1);
    else if (event.type === "reconnected") {
      setJobsRequest((n) => n + 1);
      setRunsRequest((n) => n + 1);
    } else if (event.type === "run") {
      const incoming = event.run;
      setRuns((prev) => {
        if (!prev) return prev;
        return prev.some((run) => run.id === incoming.id)
          ? prev.map((run) => (run.id === incoming.id ? incoming : run))
          : [incoming, ...prev];
      });
    }
  });

  const loadOlder = async () => {
    const last = runs?.at(-1);
    if (!last) return;
    setLoadingOlder(true);
    try {
      const { runs: older } = await portalJson<{ runs: JobRun[] }>(`/api/portal/runs${query({ before: last.id, limit: RUN_PAGE })}`);
      setRuns((prev) => {
        const known = new Set((prev ?? []).map((run) => run.id));
        return [...(prev ?? []), ...older.filter((run) => !known.has(run.id))];
      });
      setMoreRuns(older.length >= RUN_PAGE);
    } catch (e) {
      setRunsError(e instanceof Error ? e.message : "Could not load older runs.");
    } finally {
      setLoadingOlder(false);
    }
  };

  const upcoming = useMemo(
    () =>
      (jobs ?? [])
        .filter((job) => job.status === "active" || job.status === "paused")
        .sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) || a.title.localeCompare(b.title)),
    [jobs],
  );
  const putJob = useCallback((job: Job) => setJobs((prev) => (prev ?? []).map((row) => (row.id === job.id ? job : row))), []);
  const jobTitles = useMemo(() => new Map((jobs ?? []).map((job) => [job.id, job.title])), [jobs]);
  const intentsById = useMemo(() => new Map(intents.map((intent) => [intent.id, intent])), [intents]);
  const runTitle = (run: JobRun) => (run.jobId && jobTitles.get(run.jobId)) || jobKindLabels[run.kind] || run.kind;

  return (
    <ViewBody label="Goals">
      <section aria-labelledby="goals-intents">
        <SectionTitle id="goals-intents" count={intents.length}>
          Goals
        </SectionTitle>
        {intents.length === 0 ? (
          <Empty>
            No standing goals. Ask Portal to keep an eye on something (“tell me when #42 merges”) and it
            shows up here with what triggers it.
          </Empty>
        ) : (
          <div className="space-y-2.5">
            {intents.map((intent) => (
              <IntentCard key={intent.id} intent={intent} now={now} links={links} />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="goals-upcoming">
        <SectionTitle id="goals-upcoming" count={jobs ? upcoming.length : undefined}>
          Upcoming
        </SectionTitle>
        <ErrorLine>{jobsError}</ErrorLine>
        {!jobs && !jobsError && <Loading>Loading the schedule…</Loading>}
        {jobs && upcoming.length === 0 && <Empty>Nothing is scheduled.</Empty>}
        {upcoming.length > 0 && (
          <ul aria-label="Upcoming jobs" className="divide-y divide-white/5 rounded-2xl border border-white/8 bg-white/[.02]">
            {upcoming.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                intent={job.intentId ? intentsById.get(job.intentId) : undefined}
                now={now}
                links={links}
                onChanged={putJob}
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="goals-runs">
        <SectionTitle id="goals-runs">Recent runs</SectionTitle>
        <ErrorLine>{runsError}</ErrorLine>
        {!runs && !runsError && <Loading>Loading recent runs…</Loading>}
        {runs && runs.length === 0 && <Empty>Portal has not run anything yet.</Empty>}
        {runs && runs.length > 0 && (
          <ul aria-label="Recent runs" className="divide-y divide-white/5 rounded-2xl border border-white/8 bg-white/[.02]">
            {runs.map((run) => (
              <RunRow key={run.id} run={run} title={runTitle(run)} now={now} links={links} />
            ))}
          </ul>
        )}
        {moreRuns && (
          <Button type="button" variant="ghost" size="sm" disabled={loadingOlder} onClick={() => void loadOlder()} className="mt-2 text-xs text-muted-foreground">
            {loadingOlder && <LoaderCircle className="animate-spin" />}
            Show older runs
          </Button>
        )}
      </section>
    </ViewBody>
  );
}
