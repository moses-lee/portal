"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, CircleAlert, CircleCheck, CircleSlash, LoaderCircle, Sparkles, Zap } from "lucide-react";
import PortalMarkdown from "../PortalMarkdown";
import type { PortalLinks } from "../PortalPage";
import { At, Badge, Empty, ErrorLine, Loading, SectionTitle, When, type Tone } from "./bits";
import { usePortalEvents, useNow } from "./PortalLive";
import { Button } from "@/components/ui/button";
import { portalJson, portalSend, query } from "@/lib/orchestrator/api";
import { CONSOLIDATE_JOB_ID, consolidationResult, curationRunLine, groupChanges } from "@/lib/orchestrator/curation";
import { describeSchedule, describeUsage, runDuration } from "@/lib/orchestrator/format";
import type { CurationChange, Job, JobRun, RunStatus } from "@/lib/orchestrator/types";

const statusMeta: Record<RunStatus, { label: string; tone: Tone }> = {
  running: { label: "Running", tone: "sky" },
  succeeded: { label: "Done", tone: "emerald" },
  failed: { label: "Failed", tone: "rose" },
  cancelled: { label: "Stopped", tone: "neutral" },
  awaiting_approval: { label: "Waiting", tone: "amber" },
};

const RUN_PAGE = 20;

function StatusIcon({ status }: { status: RunStatus }) {
  if (status === "running") return <LoaderCircle className="size-3.5 animate-spin text-sky-300" />;
  if (status === "succeeded") return <CircleCheck className="size-3.5 text-emerald-300" />;
  if (status === "failed") return <CircleAlert className="size-3.5 text-rose-300" />;
  return <CircleSlash className="size-3.5 text-muted-foreground" />;
}

/** "Next run in 5 h", "Nightly run off", or "Paused", from the curation job. */
function describeJob(job: Job | null, now: number): string | null {
  if (!job) return null;
  if (job.status === "paused") return "Curation is paused (resume it under Goals).";
  const schedule = job.nextRunAt === null && job.schedule.type === "cron" ? "The nightly run is off" : describeSchedule(job.schedule, now);
  return job.nextRunAt === null ? `${schedule}; it runs when the inbox fills up or on Run now.` : schedule;
}

/** One record in the diff: before and after, with the reason. */
function ChangeRow({ change, links }: { change: CurationChange; links: PortalLinks }) {
  const summary = change.summary;
  const body = change.after?.body ?? change.before?.body ?? "";
  return (
    <li className="px-4 py-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => links.openEntity(change.entityId)}
          className="text-[12px] text-muted-foreground hover:text-foreground hover:underline"
        >
          {change.entity}
        </button>
        {change.key && <code className="font-mono text-[12px] text-foreground/90">{change.key}</code>}
        {change.before && change.after && change.before.status !== change.after.status && (
          <span className="text-[11px] text-muted-foreground">
            {change.before.status} → {change.after.status}
          </span>
        )}
        {change.before && !change.after && <Badge>{change.before.status}</Badge>}
        {change.before && <Badge>{change.before.authority.replace("_", " ")}</Badge>}
      </div>
      {summary ? (
        <div className="mt-1.5 space-y-1 rounded-lg bg-black/20 p-2 text-[12px] leading-relaxed">
          {summary.before && <p className="text-rose-300/80 line-through decoration-rose-300/40">{summary.before}</p>}
          {summary.after ? (
            <div className="text-emerald-300/90">
              <PortalMarkdown text={summary.after} compact />
            </div>
          ) : (
            <p className="text-muted-foreground">(cleared)</p>
          )}
        </div>
      ) : (
        body && (
          <div className={`mt-1 ${change.action === "superseded" || change.action === "rejected" || change.action === "expired" ? "text-foreground/60" : "text-foreground/90"}`}>
            <PortalMarkdown text={body} compact />
          </div>
        )
      )}
      {change.replacedBy && <p className="mt-1 text-[11px] text-muted-foreground">Replaced by {change.replacedBy}</p>}
      {change.reason && <p className="mt-1 text-[11px] text-muted-foreground">“{change.reason}”</p>}
    </li>
  );
}

/** One curation run: status, the digest, and the diff grouped by what happened. */
function CurationRunDetail({ runId, onBack, links }: { runId: string; onBack: () => void; links: PortalLinks }) {
  const now = useNow(30_000);
  const [run, setRun] = useState<JobRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  usePortalEvents((event) => {
    if (event.type === "run" && event.run.id === runId) setRun(event.run);
    else if (event.type === "reconnected") setVersion((n) => n + 1);
  });
  useEffect(() => {
    const controller = new AbortController();
    portalJson<{ run: JobRun }>(`/api/portal/runs/${encodeURIComponent(runId)}`, { signal: controller.signal })
      .then(({ run }) => {
        setRun(run);
        setError(null);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Could not load that run.");
      });
    return () => controller.abort();
  }, [runId, version]);
  const shown = run && run.id === runId ? run : null;
  const result = shown ? consolidationResult(shown) : null;
  const groups = result ? groupChanges(result.changes) : [];
  const meta = shown ? statusMeta[shown.status] : null;
  return (
    <section aria-label="Curation run" className="space-y-5">
      <Button type="button" variant="ghost" size="sm" onClick={onBack} className="-ml-2 text-xs text-muted-foreground">
        <ArrowLeft />
        Curation
      </Button>
      <ErrorLine>{error}</ErrorLine>
      {!shown && !error && <Loading>Loading the run…</Loading>}
      {shown && meta && (
        <>
          <div>
            <p className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">Memory curation</p>
            <h2 className="mt-0.5 flex flex-wrap items-center gap-2 text-lg font-medium tracking-tight">
              <At at={shown.startedAt} now={now} />
              <Badge tone={meta.tone}>{meta.label}</Badge>
            </h2>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
              <span>{shown.trigger === "manual" ? "Run now" : "Scheduled"}</span>
              <span>·</span>
              <span>{runDuration(shown, now)}</span>
              <span>·</span>
              <span>{shown.model ? `${shown.model.provider} · ${shown.model.model}` : "no model call"}</span>
              {shown.usage && (
                <>
                  <span>·</span>
                  <span>{describeUsage(shown.usage)}</span>
                </>
              )}
            </p>
          </div>
          {shown.status === "running" && <Loading>Curating… the digest appears when the pass ends.</Loading>}
          {shown.error && !result?.refused && <p className="text-xs text-destructive">{shown.error}</p>}
          {result && (
            <div className="rounded-2xl border border-white/8 bg-white/[.025] p-4 text-[13px]">
              <PortalMarkdown text={result.digest} compact />
              <p className="mt-3 text-[11px] text-muted-foreground">
                Looked at {result.considered.inbox} in the inbox, {result.considered.active} active, {result.considered.overdue} past review,{" "}
                {result.considered.entities} entities.
              </p>
            </div>
          )}
          {groups.map((group) => (
            <section key={group.action} aria-label={`${group.label} (${group.changes.length})`}>
              <SectionTitle count={group.changes.length}>
                <span className="inline-flex items-center gap-1.5">
                  {group.label}
                  {result?.refused && <Badge tone="rose">not applied</Badge>}
                </span>
              </SectionTitle>
              <ul className="divide-y divide-white/5 rounded-2xl border border-white/8 bg-white/[.02]">
                {group.changes.map((change, index) => (
                  <ChangeRow key={`${change.recordId ?? change.entityId}-${index}`} change={change} links={links} />
                ))}
              </ul>
            </section>
          ))}
          {shown.log.length > 0 && (
            <details className="text-[11px] text-muted-foreground">
              <summary className="cursor-pointer hover:text-foreground">Log ({shown.log.length})</summary>
              <ol className="mt-2 space-y-0.5 border-l border-white/10 pl-3 leading-relaxed">
                {shown.log.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ol>
            </details>
          )}
        </>
      )}
    </section>
  );
}

/**
 * Memory curation (the consolidator): when it runs next, "Run now", and its recent runs, each
 * opening its digest and the diff by action. Runs update from `run` events; the job from `jobs`.
 */
export default function CurationView({
  runId,
  onSelectRun,
  links,
}: {
  /** From the URL; null lists the runs. */
  runId: string | null;
  onSelectRun: (runId: string | null) => void;
  links: PortalLinks;
}) {
  const now = useNow(60_000);
  const [runs, setRuns] = useState<JobRun[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [runsRequest, setRunsRequest] = useState(0);
  const [jobRequest, setJobRequest] = useState(0);

  usePortalEvents((event) => {
    if (event.type === "jobs") setJobRequest((n) => n + 1);
    else if (event.type === "reconnected") {
      setJobRequest((n) => n + 1);
      setRunsRequest((n) => n + 1);
    } else if (event.type === "run" && event.run.kind === "consolidate") {
      const incoming = event.run;
      setRuns((prev) => {
        if (!prev) return prev;
        return prev.some((entry) => entry.id === incoming.id) ? prev.map((entry) => (entry.id === incoming.id ? incoming : entry)) : [incoming, ...prev];
      });
    }
  });

  useEffect(() => {
    const controller = new AbortController();
    portalJson<{ runs: JobRun[] }>(`/api/portal/runs${query({ kind: "consolidate", limit: RUN_PAGE })}`, { signal: controller.signal })
      .then(({ runs }) => {
        setRuns(runs);
        setRunsError(null);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setRunsError(e instanceof Error ? e.message : "Could not load the curation runs.");
      });
    return () => controller.abort();
  }, [runsRequest]);

  useEffect(() => {
    const controller = new AbortController();
    portalJson<{ jobs: Job[] }>("/api/portal/jobs", { signal: controller.signal })
      .then(({ jobs }) => setJob(jobs.find((entry) => entry.id === CONSOLIDATE_JOB_ID) ?? null))
      .catch(() => {});
    return () => controller.abort();
  }, [jobRequest]);

  const runNow = useCallback(async () => {
    setStarting(true);
    setStartError(null);
    try {
      const { run } = await portalSend<{ run: JobRun }>("/api/portal/memory/consolidate", "POST", undefined, "Could not start curation. Try again.");
      onSelectRun(run.id);
    } catch (e) {
      setStartError(e instanceof Error ? e.message : "Could not start curation. Try again.");
    } finally {
      setStarting(false);
    }
  }, [onSelectRun]);

  if (runId) return <CurationRunDetail runId={runId} onBack={() => onSelectRun(null)} links={links} />;

  const running = runs?.some((run) => run.status === "running") ?? false;
  const next = describeJob(job, now);
  return (
    <section aria-labelledby="memory-curation">
      <SectionTitle
        id="memory-curation"
        actions={
          <Button type="button" size="sm" variant="secondary" disabled={starting || running || job?.status === "paused"} onClick={() => void runNow()} className="text-xs">
            {starting || running ? <LoaderCircle className="animate-spin" /> : <Zap />}
            Run now
          </Button>
        }
      >
        Curation
      </SectionTitle>
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        Portal curates memory on its own: it promotes observations it saw more than once, drops
        duplicates, retires claims past their review date, and rewrites the entity summaries. It
        never overrules what you said. Each run keeps a digest and the changes it made.
      </p>
      {job && next && (
        <p className="mb-3 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <Sparkles className="size-3" />
          <span>{next}</span>
          {job.nextRunAt !== null && job.status === "active" && (
            <>
              <span>·</span>
              <When at={job.nextRunAt} now={now} prefix="next" />
            </>
          )}
        </p>
      )}
      <ErrorLine>{startError}</ErrorLine>
      <ErrorLine>{runsError}</ErrorLine>
      {!runs && !runsError && <Loading>Loading curation runs…</Loading>}
      {runs && runs.length === 0 && <Empty>Curation has not run yet.</Empty>}
      {runs && runs.length > 0 && (
        <ul aria-label="Curation runs" className="divide-y divide-white/5 rounded-2xl border border-white/8 bg-white/[.02]">
          {runs.map((run) => (
            <li key={run.id}>
              <button type="button" onClick={() => onSelectRun(run.id)} className="flex w-full items-start gap-2.5 px-4 py-3 text-left hover:bg-white/[.03]">
                <span className="mt-0.5">
                  <StatusIcon status={run.status} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] leading-relaxed text-foreground/90">{curationRunLine(run)}</span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    <At at={run.startedAt} now={now} /> · {run.trigger === "manual" ? "Run now" : "scheduled"}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
