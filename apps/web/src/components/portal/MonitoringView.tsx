"use client";

import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRight, FolderX, LoaderCircle, Play, RefreshCw, Square, Trash2, X } from "lucide-react";
import type { AttributedProcess, MonitoringLevel, MonitoringSnapshot } from "@portal/contracts/monitoring";
import type { PortalLinks } from "../PortalPage";
import { RemoveConfirm } from "../ProjectActions";
import SessionStateBadge from "../SessionStateBadge";
import { useSettings } from "../useSettings";
import type { RemoveProjectOptions } from "../useProjects";
import { Badge, ConfirmButton, Empty, ErrorLine, Loading, SectionTitle, ViewBody } from "./bits";
import { Button } from "@/components/ui/button";
import { isAbort, portalJson, portalSend } from "@/lib/orchestrator/api";
import { formatClock } from "@/lib/orchestrator/format";
import {
  chartModels,
  cleanupSummary,
  commandName,
  formatBytes,
  formatGb,
  homeSplit,
  levelLabels,
  levelTones,
  linePath,
  measuredText,
  otherRows,
  portalRoleLabels,
  portalRows,
  processTree,
  sessionRows,
  spanText,
  canStop,
  stopHint,
  summaryTiles,
  worktreeRows,
  type ChartModel,
  type CleanupScriptResult,
  type SummaryTile,
  type TreeRow,
  type WorktreeRowView,
} from "@/lib/monitoring";
import { isScriptEnabled } from "@/lib/scripts";
import { sessionDisplayTitle } from "@/lib/session-title";
import type { ProjectSummary } from "@/lib/types";

/** How often the open view asks for a fresh snapshot (docs/MONITORING.md, Sampler and API). */
const POLL_MS = 5_000;
/** How long an action's error stays up when nothing else replaces it. */
const ACTION_ERROR_MS = 15_000;
const DAY_MS = 24 * 60 * 60_000;

const tileClass: Record<MonitoringLevel, string> = {
  normal: "border-white/8 bg-white/[.03]",
  warning: "border-amber-300/25 bg-amber-300/10 text-amber-50",
  critical: "border-rose-400/30 bg-rose-400/12 text-rose-50",
};

const bandFill: Record<Exclude<MonitoringLevel, "normal">, string> = {
  warning: "fill-amber-300/15",
  critical: "fill-rose-400/20",
};

/* A table on wide screens, a stack of cards on phones: each cell names its column there. The roles are
 * spelled out because a table restyled as blocks loses them in some browsers. */

function DataTable({ label, head, children }: { label: string; head: string[]; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-white/[.02] max-sm:border-0 max-sm:bg-transparent">
      <table role="table" aria-label={label} className="w-full text-left text-xs max-sm:block">
        <thead role="rowgroup" className="max-sm:hidden">
          <tr role="row" className="border-b border-white/5 text-[10px] tracking-wider text-muted-foreground uppercase">
            {head.map((cell, index) => (
              <th key={`${cell}-${index}`} role="columnheader" scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup" className="divide-y divide-white/5 max-sm:block max-sm:space-y-2 max-sm:divide-y-0">{children}</tbody>
      </table>
    </div>
  );
}

function Row({ children, label, className = "", highlight = false }: { children: ReactNode; label?: string; className?: string; highlight?: boolean }) {
  return (
    <tr
      role="row"
      aria-label={label}
      data-highlight={highlight || undefined}
      className={`max-sm:block max-sm:rounded-xl max-sm:border max-sm:border-white/8 max-sm:bg-white/[.02] max-sm:p-3 ${highlight ? "bg-amber-300/[.06] max-sm:border-amber-300/25 max-sm:bg-amber-300/[.06]" : ""} ${className}`}
    >
      {children}
    </tr>
  );
}

function Cell({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <td
      role="cell"
      data-label={label}
      className={`px-3 py-2 align-top max-sm:flex max-sm:items-baseline max-sm:justify-between max-sm:gap-3 max-sm:px-0 max-sm:py-0.5 max-sm:before:shrink-0 max-sm:before:text-muted-foreground max-sm:before:content-[attr(data-label)] ${className}`}
    >
      {/* One box, so on a phone the label and the whole value sit apart rather than every piece of the value. */}
      <div className="min-w-0 max-sm:max-w-[70%] max-sm:text-right">{children}</div>
    </td>
  );
}

/** A row's expanded part: on wide screens one cell across the table, on phones the rest of the card. */
function Detail({ span, children }: { span: number; children: ReactNode }) {
  return (
    <tr role="row" className="max-sm:-mt-2 max-sm:block max-sm:rounded-b-xl max-sm:border max-sm:border-t-0 max-sm:border-white/8 max-sm:px-3 max-sm:pb-3">
      <td role="cell" colSpan={span} className="px-3 pb-3 max-sm:block max-sm:px-0">
        {children}
      </td>
    </tr>
  );
}

function ExpandButton({ open, onToggle, label, children }: { open: boolean; onToggle: () => void; label: string; children: ReactNode }) {
  return (
    <button type="button" aria-expanded={open} aria-label={label} onClick={onToggle} className="flex min-w-0 items-start gap-1 text-left hover:text-foreground">
      <ChevronRight className={`mt-0.5 size-3 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
      <span className="min-w-0">{children}</span>
    </button>
  );
}

function Tile({ tile }: { tile: SummaryTile }) {
  return (
    <div
      role="group"
      aria-label={`${tile.label}: ${tile.value}, ${tile.detail}`}
      data-tile={tile.key}
      data-level={tile.level}
      className={`min-w-0 rounded-2xl border px-3.5 py-3 ${tileClass[tile.level]}`}
    >
      <p className="flex items-center gap-1.5 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
        {tile.label}
        {tile.level !== "normal" && <Badge tone={levelTones[tile.level]}>{levelLabels[tile.level]}</Badge>}
      </p>
      <p className="mt-1 truncate text-[15px] font-medium tracking-[-.01em]">{tile.value}</p>
      <p className="truncate text-[11px] text-muted-foreground" title={tile.detail}>{tile.detail}</p>
    </div>
  );
}

const CHART_W = 300;
const CHART_H = 72;

/**
 * One small line chart over the last 24 h: the reading as a 2px line, warning and critical as
 * bands behind it (pressure over time, or the disk levels by value), and a crosshair with the
 * reading under the pointer.
 */
function Chart({ model, now }: { model: ChartModel; now: number }) {
  const frame = { from: now - DAY_MS, to: now, yMax: model.yMax, width: CHART_W, height: CHART_H };
  // The hovered point by its time, not its index: the next poll may drop the oldest points, and the
  // point under the pointer may be gone with them (then the latest reading shows again).
  const [hoverAt, setHoverAt] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const latest = [...model.points].reverse().find((point) => point.value !== null) ?? null;
  const hovered = hoverAt !== null ? (model.points.find((point) => point.at === hoverAt) ?? null) : null;
  const shown = hovered ?? latest;
  const x = (at: number) => ((at - frame.from) / (frame.to - frame.from)) * CHART_W;
  const y = (value: number) => CHART_H - (Math.min(value, frame.yMax) / (frame.yMax || 1)) * CHART_H;
  const onMove = (clientX: number) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || model.points.length === 0) return;
    const at = frame.from + ((clientX - box.left) / box.width) * (frame.to - frame.from);
    let best = 0;
    model.points.forEach((point, index) => {
      if (Math.abs(point.at - at) < Math.abs(model.points[best].at - at)) best = index;
    });
    setHoverAt(model.points[best].at);
  };
  return (
    <figure data-chart={model.key} className="min-w-0 rounded-2xl border border-white/8 bg-white/[.02] px-3.5 pt-3 pb-2.5">
      <figcaption className="mb-2 flex items-baseline justify-between gap-2 text-[11px]">
        <span className="font-medium text-foreground/85">{model.label}</span>
        <span className="truncate text-muted-foreground tabular-nums">
          {shown && shown.value !== null ? `${hovered ? `${formatClock(shown.at)} · ` : ""}${formatBytes(shown.value, model.kind)}` : "—"}
        </span>
      </figcaption>
      {model.points.length === 0 ? (
        <p className="flex h-[72px] items-center justify-center text-[11px] text-muted-foreground">No history yet</p>
      ) : (
        <svg
          ref={svgRef}
          role="img"
          aria-label={`${model.label} over the last 24 hours`}
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          preserveAspectRatio="none"
          className="block h-[72px] w-full touch-pan-y overflow-visible"
          onPointerMove={(event) => onMove(event.clientX)}
          onPointerLeave={() => setHoverAt(null)}
        >
          {model.timeBands.map((band) => (
            <rect key={`t${band.from}`} x={x(Math.max(band.from, frame.from))} y={0} width={Math.max(0.5, x(band.to) - x(Math.max(band.from, frame.from)))} height={CHART_H} className={bandFill[band.level]} />
          ))}
          {model.valueBands.map((band) => (
            <rect key={`v${band.level}`} x={0} y={y(band.max)} width={CHART_W} height={Math.max(0, y(band.min) - y(band.max))} className={bandFill[band.level]} />
          ))}
          <line x1={0} x2={CHART_W} y1={CHART_H} y2={CHART_H} className="stroke-white/10" vectorEffect="non-scaling-stroke" />
          <path d={linePath(model.points, frame)} fill="none" className="stroke-primary" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          {hovered && <line x1={x(hovered.at)} x2={x(hovered.at)} y1={0} y2={CHART_H} className="stroke-white/30" vectorEffect="non-scaling-stroke" />}
        </svg>
      )}
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground/70">
        <span>24 h ago</span>
        <span>now</span>
      </div>
    </figure>
  );
}

/** The server's reason a process may not be stopped, as a sentence. */
const reasonText = (process: AttributedProcess) => {
  const hint = stopHint(process) ?? "";
  return hint.charAt(0).toUpperCase() + hint.slice(1);
};

/**
 * Stop with a second click to confirm, where Portal may stop the process. Otherwise "Can't stop",
 * which a tap opens to say why (the row shows the reason under `reasonId`, which screen readers
 * get either way); the reason is the hover title too.
 */
function StopSlot({
  process,
  onStop,
  stopping,
  reasonId,
  revealed,
  onReveal,
}: {
  process: AttributedProcess;
  onStop: (process: AttributedProcess) => void;
  stopping: number | null;
  reasonId: string;
  revealed: boolean;
  onReveal: () => void;
}) {
  if (!canStop(process)) {
    return (
      <>
        <button
          type="button"
          aria-expanded={revealed}
          aria-describedby={reasonId}
          title={reasonText(process)}
          onClick={onReveal}
          className="text-[10px] text-muted-foreground/80 underline decoration-dotted underline-offset-2 hover:text-foreground"
        >
          Can&apos;t stop
        </button>
        {!revealed && <span id={reasonId} className="sr-only">{reasonText(process)}</span>}
      </>
    );
  }
  return <ConfirmButton label="Stop" confirmLabel="Confirm stop" icon={stopping === process.pid ? <LoaderCircle className="animate-spin" /> : <Square />} disabled={stopping !== null} onConfirm={() => onStop(process)} />;
}

/** "via pid 4100": a process charged to a worktree because an ancestor of it is. */
function Inherited({ process }: { process: AttributedProcess }) {
  if (typeof process.inheritedFrom !== "number") return null;
  return <span className="ml-1.5 font-sans text-[10px] text-muted-foreground">via pid {process.inheritedFrom}</span>;
}

type StopProps = { onStop: (process: AttributedProcess) => void; stopping: number | null };

/** One process in an expanded row: its command (indented by depth), pid, memory and age, and Stop when Portal may stop it. */
function ProcessItem({ process, depth, onStop, stopping }: TreeRow & StopProps) {
  const [why, setWhy] = useState(false);
  const reasonId = useId();
  return (
    <li aria-label={`Process ${process.pid}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-[11px]">
      <span className="min-w-0 flex-1 truncate font-mono max-sm:basis-full" style={{ paddingLeft: `${depth * 12}px` }} title={process.command}>
        {depth > 0 && <span className="text-muted-foreground">└ </span>}
        {commandName(process.command)}
        <Inherited process={process} />
      </span>
      {process.orphan && <Badge tone="amber">Orphan</Badge>}
      <span className="w-14 shrink-0 text-muted-foreground tabular-nums">{process.pid}</span>
      <span className="w-16 shrink-0 text-right tabular-nums">{formatBytes(process.memoryBytes, "memory")}</span>
      <span className="w-14 shrink-0 text-right text-muted-foreground tabular-nums">{spanText(process.elapsedSeconds * 1000)}</span>
      <span className="w-24 shrink-0 text-right">
        <StopSlot process={process} onStop={onStop} stopping={stopping} reasonId={reasonId} revealed={why} onReveal={() => setWhy((open) => !open)} />
      </span>
      {why && <p id={reasonId} className="basis-full text-right text-[10px] text-muted-foreground">{reasonText(process)}</p>}
    </li>
  );
}

function ProcessList({ rows, onStop, stopping }: { rows: TreeRow[] } & StopProps) {
  if (rows.length === 0) return <p className="py-1 text-[11px] text-muted-foreground">No processes right now.</p>;
  return (
    <ul aria-label="Processes" className="divide-y divide-white/5 rounded-xl border border-white/6 bg-black/15">
      {rows.map((row) => <ProcessItem key={row.process.pid} {...row} onStop={onStop} stopping={stopping} />)}
    </ul>
  );
}

function ProcessTableRow({ process, roleOf, onStop, stopping }: { process: AttributedProcess; roleOf?: (process: AttributedProcess) => string; onStop?: StopProps["onStop"]; stopping: number | null }) {
  const [why, setWhy] = useState(false);
  const reasonId = useId();
  return (
    <Row label={`Process ${process.pid}`}>
      {roleOf && <Cell label="Role">{roleOf(process)}</Cell>}
      <Cell label="Command" className="max-w-[420px]">
        <span className="block truncate font-mono text-[11px]" title={process.command}>{commandName(process.command)}<Inherited process={process} /></span>
      </Cell>
      <Cell label="PID" className="text-muted-foreground tabular-nums">{process.pid}</Cell>
      <Cell label="Memory" className="tabular-nums">{formatBytes(process.memoryBytes, "memory")}</Cell>
      <Cell label="Age" className="text-muted-foreground tabular-nums">{spanText(process.elapsedSeconds * 1000)}</Cell>
      {onStop && (
        <Cell label="" className="text-right max-sm:justify-end max-sm:before:content-none">
          <StopSlot process={process} onStop={onStop} stopping={stopping} reasonId={reasonId} revealed={why} onReveal={() => setWhy((open) => !open)} />
          {why && <span id={reasonId} className="block max-w-48 text-[10px] whitespace-normal text-muted-foreground sm:ml-auto">{reasonText(process)}</span>}
        </Cell>
      )}
    </Row>
  );
}

/** A plain process table for the Portal and Other sections. */
function ProcessTable({ label, rows, roleOf, onStop, stopping }: { label: string; rows: AttributedProcess[]; roleOf?: (process: AttributedProcess) => string; onStop?: StopProps["onStop"]; stopping: number | null }) {
  const head = [...(roleOf ? ["Role"] : []), "Command", "PID", "Memory", "Age", ...(onStop ? [""] : [])];
  return (
    <DataTable label={label} head={head}>
      {rows.map((process) => <ProcessTableRow key={process.pid} process={process} roleOf={roleOf} onStop={onStop} stopping={stopping} />)}
    </DataTable>
  );
}

/**
 * Monitoring (docs/MONITORING.md): memory, swap, pressure and disk, and what uses them, charged to
 * sessions, worktrees and Portal, with the manual actions. Polls `GET /api/monitoring` every 5 s
 * while open and the page is visible; colours stay here (no badge, no alert elsewhere).
 */
export default function MonitoringView({
  links,
  projects,
  onRemoveProject,
}: {
  links: PortalLinks;
  /** The listed projects, for the existing removal confirmation. */
  projects: ProjectSummary[];
  onRemoveProject: (id: string, opts?: RemoveProjectOptions) => Promise<void>;
}) {
  const [snapshot, setSnapshot] = useState<MonitoringSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ActionError | null>(null);
  const [reload, setReload] = useState(0);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [stopping, setStopping] = useState<number | null>(null);
  const [stoppingCli, setStoppingCli] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [cleaning, setCleaning] = useState<string | null>(null);
  const [confirmCleanup, setConfirmCleanup] = useState<string | null>(null);
  const [cleanup, setCleanup] = useState<Record<string, { result?: CleanupScriptResult; error?: string }>>({});
  const { settings } = useSettings();
  const scriptSet = !!settings && isScriptEnabled(settings.scripts.preWorktreeDelete);

  // Poll while mounted and the page is visible: one request at a time, the next 5 s after the last
  // answer. A hidden page asks nothing; on showing again it asks at once and polls on from there.
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let loading = false;
    const stopTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const load = async () => {
      stopTimer();
      if (loading) return;
      loading = true;
      try {
        const next = await portalJson<MonitoringSnapshot>("/api/monitoring", { signal: controller.signal }, "Could not read the numbers.");
        setSnapshot(next);
        setError(null);
      } catch (e) {
        if (isAbort(e)) return;
        setError(e instanceof Error ? e.message : "Could not read the numbers.");
      } finally {
        loading = false;
      }
      if (!controller.signal.aborted && !document.hidden) timer = setTimeout(load, POLL_MS);
    };
    const onVisibility = () => {
      if (document.hidden) stopTimer();
      else void load();
    };
    void load();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      controller.abort();
      stopTimer();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reload]);
  const refetch = useCallback(() => setReload((n) => n + 1), []);

  // An action's error stays until the next action, or a while.
  useEffect(() => {
    if (!actionError) return;
    const timer = setTimeout(() => setActionError(null), ACTION_ERROR_MS);
    return () => clearTimeout(timer);
  }, [actionError]);

  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /** Runs an action; its error is shown in `scope` (the section it came from), naming `what`. */
  const act = async (scope: ActionScope, what: string, fallback: string, action: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await action();
      return true;
    } catch (e) {
      setActionError({ scope, message: `${what}: ${e instanceof Error ? e.message : fallback}` });
      return false;
    }
  };

  const stopProcess = async (scope: ActionScope, process: AttributedProcess) => {
    setStopping(process.pid);
    await act(scope, `Process ${process.pid}`, "Could not stop the process.", () => portalSend(`/api/monitoring/processes/${process.pid}/stop`, "POST", undefined, "Could not stop the process."));
    setStopping(null);
    refetch();
  };

  const stopCli = async (sessionId: string, title: string) => {
    setStoppingCli(sessionId);
    await act("sessions", title, "Could not stop the CLI.", () => portalSend(`/api/sessions/${encodeURIComponent(sessionId)}/stop-cli`, "POST", undefined, "Could not stop the CLI."));
    setStoppingCli(null);
    refetch();
  };

  const runCleanup = async (projectId: string) => {
    setActionError(null);
    setConfirmCleanup(null);
    setCleaning(projectId);
    setCleanup((prev) => ({ ...prev, [projectId]: {} }));
    try {
      const result = await portalSend<CleanupScriptResult>(`/api/projects/${encodeURIComponent(projectId)}/cleanup-script`, "POST", undefined, "Could not run the cleanup script.");
      setCleanup((prev) => ({ ...prev, [projectId]: { result } }));
      setOpen((prev) => new Set(prev).add(`w:${projectId}`));
    } catch (e) {
      setCleanup((prev) => ({ ...prev, [projectId]: { error: e instanceof Error ? e.message : "Could not run the cleanup script." } }));
    } finally {
      setCleaning(null);
      refetch();
    }
  };

  const dismissCleanup = (projectId: string) =>
    setCleanup((prev) => {
      const next = { ...prev };
      delete next[projectId];
      return next;
    });

  const refreshDisk = async () => {
    setRefreshing(true);
    await act("disk", "Refresh", "Could not start measuring.", async () => {
      const { disk } = await portalSend<{ disk: MonitoringSnapshot["disk"] }>("/api/monitoring/disk/refresh", "POST", undefined, "Could not start measuring.");
      setSnapshot((prev) => (prev ? { ...prev, disk } : prev));
    });
    setRefreshing(false);
  };

  const errorIn = (scope: ActionScope) => (actionError?.scope === scope ? actionError.message : null);

  const view = useMemo(() => {
    if (!snapshot?.supported) return null;
    // The server's clock places the rows; the 5 s poll moves the countdowns and ages on.
    const at = snapshot.now;
    const sessions = sessionRows(snapshot, at);
    const worktrees = worktreeRows(snapshot, at);
    // Each row's process tree, built once per snapshot rather than on every render of an open row.
    const trees = new Map<string, TreeRow[]>([
      ...sessions.map((row) => [`s:${row.sessionId}`, processTree(snapshot.processes, row.pids)] as const),
      ...worktrees.map((row) => [`w:${row.projectId}`, processTree(snapshot.processes, row.pids)] as const),
    ]);
    return {
      tiles: summaryTiles(snapshot),
      charts: chartModels(snapshot),
      sessions,
      worktrees,
      trees,
      portal: portalRows(snapshot.processes),
      others: otherRows(snapshot.processes),
      at,
    };
  }, [snapshot]);

  if (!snapshot) {
    return (
      <ViewBody label="Monitoring" wide>
        <ErrorLine>{error}</ErrorLine>
        {!error && <Loading>Reading memory and disk…</Loading>}
      </ViewBody>
    );
  }

  if (!snapshot.supported || !view) {
    return (
      <ViewBody label="Monitoring" wide>
        <Empty>Not supported on this OS. Monitoring reads memory, swap and disk on macOS and Linux.</Empty>
      </ViewBody>
    );
  }

  const projectById = new Map(projects.map((project) => [project.id, project]));
  const survey = snapshot.disk.survey;

  const worktreeActions = (row: WorktreeRowView) => {
    const disabledWhy = !scriptSet ? "No cleanup script is set (Settings › Scripts)" : row.busy ? "A session in this worktree is busy" : undefined;
    return (
      <div className="flex flex-wrap justify-end gap-1">
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="text-muted-foreground"
          disabled={!!disabledWhy || cleaning !== null}
          title={disabledWhy ?? "Run your pre-deletion script in this worktree without removing it"}
          onClick={() => setConfirmCleanup(row.projectId)}
        >
          {cleaning === row.projectId ? <LoaderCircle className="animate-spin" /> : <Play />}
          Run cleanup script
        </Button>
        {projectById.has(row.projectId) && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="text-muted-foreground"
            disabled={cleaning === row.projectId}
            title={cleaning === row.projectId ? "Wait for the cleanup script to finish" : undefined}
            onClick={() => setRemoving(row.projectId)}
          >
            <Trash2 />
            Remove worktree
          </Button>
        )}
      </div>
    );
  };

  return (
    <ViewBody label="Monitoring" wide>
      <section aria-labelledby="monitoring-summary" className="space-y-3">
        <h2 id="monitoring-summary" className="sr-only">Summary</h2>
        <ErrorLine>{error}</ErrorLine>
        {view.tiles ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {view.tiles.map((tile) => <Tile key={tile.key} tile={tile} />)}
          </div>
        ) : (
          <Loading>Taking the first sample…</Loading>
        )}
        <div className="grid gap-2 sm:grid-cols-3">
          {view.charts.map((model) => <Chart key={model.key} model={model} now={view.at} />)}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Bands mark warning and critical: memory pressure over time on the first two, below {formatGb(snapshot.levels.warnFreeGb)} and {formatGb(snapshot.levels.criticalFreeGb)} free on the disk.
        </p>
      </section>

      <section aria-labelledby="monitoring-sessions">
        <SectionTitle id="monitoring-sessions" count={view.sessions.length}>Sessions</SectionTitle>
        <ScopedError>{errorIn("sessions")}</ScopedError>
        {view.sessions.length === 0 ? (
          <Empty>No session has a live agent CLI.</Empty>
        ) : (
          <DataTable label="Sessions" head={["Session", "Project", "State", "Memory", "Processes", "Idle", "Idle stop", ""]}>
            {view.sessions.map((row) => {
              const key = `s:${row.sessionId}`;
              const title = sessionDisplayTitle(row.title);
              // A busy session's CLI is mid-turn (or waiting on an approval, or running background work): stopping it would cut that off.
              const busy = row.busy || row.idleSince === null;
              return (
                <Fragment key={row.sessionId}>
                  <Row label={title}>
                    <Cell label="Session" className="max-w-[260px]">
                      <ExpandButton open={open.has(key)} onToggle={() => toggle(key)} label={`Processes of ${title}`}>
                        <span className="block truncate">{title}</span>
                      </ExpandButton>
                      <button type="button" onClick={() => links.openSession(row.sessionId)} className="ml-4 text-[10px] text-muted-foreground hover:underline">
                        {row.agentName} · open
                      </button>
                    </Cell>
                    <Cell label="Project">{row.projectName ?? "—"}</Cell>
                    <Cell label="State"><SessionStateBadge state={row.state} /></Cell>
                    <Cell label="Memory" className="tabular-nums">{formatBytes(row.memoryBytes, "memory")}</Cell>
                    <Cell label="Processes" className="tabular-nums">{row.processCount}</Cell>
                    <Cell label="Idle" className="text-muted-foreground">{row.idleText}</Cell>
                    <Cell label="Idle stop" className="text-muted-foreground">{row.stopText}</Cell>
                    <Cell label="" className="text-right max-sm:justify-end max-sm:before:content-none">
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        className="text-muted-foreground"
                        disabled={stoppingCli !== null || busy}
                        title={busy ? "The session is busy; stop the CLI once it is idle" : "Stop this session's agent CLI; the next prompt starts it again"}
                        aria-describedby={busy ? `busy-${row.sessionId}` : undefined}
                        onClick={() => void stopCli(row.sessionId, title)}
                      >
                        {stoppingCli === row.sessionId ? <LoaderCircle className="animate-spin" /> : <Square />}
                        Stop CLI
                      </Button>
                      {busy && <span id={`busy-${row.sessionId}`} className="block text-[10px] text-muted-foreground">Busy; stop once idle</span>}
                    </Cell>
                  </Row>
                  {open.has(key) && (
                    <Detail span={8}>
                      <ProcessList rows={view.trees.get(key) ?? []} onStop={(process) => void stopProcess("sessions", process)} stopping={stopping} />
                    </Detail>
                  )}
                </Fragment>
              );
            })}
          </DataTable>
        )}
      </section>

      <section aria-labelledby="monitoring-worktrees">
        <SectionTitle id="monitoring-worktrees" count={view.worktrees.length}>Worktrees</SectionTitle>
        <ScopedError>{errorIn("worktrees")}</ScopedError>
        {view.worktrees.length === 0 ? (
          <Empty>No worktree projects.</Empty>
        ) : (
          <DataTable label="Worktrees" head={["Worktree", "Size", "Sessions", "Memory", "State", ""]}>
            {view.worktrees.map((row) => {
              const key = `w:${row.projectId}`;
              const project = projectById.get(row.projectId);
              const outcome = cleanup[row.projectId];
              return (
                <Fragment key={row.projectId}>
                  <Row label={row.name} highlight={row.stale}>
                    <Cell label="Worktree" className="max-w-[260px]">
                      <ExpandButton open={open.has(key)} onToggle={() => toggle(key)} label={`Processes of ${row.name}`}>
                        <span className="block truncate">{row.name}</span>
                        <span className="block truncate font-mono text-[10px] text-muted-foreground">{row.branch}</span>
                      </ExpandButton>
                    </Cell>
                    <Cell label="Size" className="tabular-nums">{formatBytes(row.sizeBytes)}</Cell>
                    <Cell label="Sessions" className="tabular-nums">{row.sessionCount}</Cell>
                    <Cell label="Memory" className="tabular-nums whitespace-nowrap">
                      {formatBytes(row.memoryBytes, "memory")}
                      <span className="text-muted-foreground"> · {row.processCount} {row.processCount === 1 ? "process" : "processes"}</span>
                    </Cell>
                    <Cell label="State" className={row.stale ? "text-amber-200" : "text-muted-foreground"}>{row.lifecycle}</Cell>
                    <Cell label="" className="max-sm:block max-sm:pt-1.5 max-sm:before:content-none max-sm:[&>div]:max-w-none">{worktreeActions(row)}</Cell>
                  </Row>
                  {(open.has(key) || confirmCleanup === row.projectId || removing === row.projectId || outcome) && (
                    <Detail span={6}>
                      <div className="space-y-2">
                        {confirmCleanup === row.projectId && (
                          <div role="group" aria-label={`Run the cleanup script in ${row.name}?`} className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-white/[.04] px-3 py-2 text-xs">
                            <span className="flex-1">Run your pre-deletion script in <span className="font-medium">{row.name}</span>? The worktree stays.</span>
                            <Button type="button" size="xs" onClick={() => void runCleanup(row.projectId)}>Run script</Button>
                            <Button type="button" size="xs" variant="ghost" onClick={() => setConfirmCleanup(null)}>Cancel</Button>
                          </div>
                        )}
                        {(outcome?.error || outcome?.result) && (
                          <div role="status" aria-label={`Cleanup script in ${row.name}`} className="text-[11px]">
                            <div className="flex items-start gap-2">
                              <div className="min-w-0 flex-1">
                                {outcome.error && <ErrorLine>{outcome.error}</ErrorLine>}
                                {outcome.result && <p className={outcome.result.ok ? "text-muted-foreground" : "text-amber-200"}>Cleanup script: {cleanupSummary(outcome.result)}</p>}
                              </div>
                              <Button type="button" size="icon-xs" variant="ghost" className="text-muted-foreground" aria-label="Dismiss the cleanup output" title="Dismiss" onClick={() => dismissCleanup(row.projectId)}>
                                <X />
                              </Button>
                            </div>
                            {outcome.result && (outcome.result.stdout || outcome.result.stderr) && (
                              <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-black/25 p-2 font-mono text-[10.5px] whitespace-pre-wrap text-foreground/75">{[outcome.result.stdout, outcome.result.stderr].filter(Boolean).join("\n")}</pre>
                            )}
                          </div>
                        )}
                        {removing === row.projectId && project && (
                          <RemoveConfirm
                            project={project}
                            onCancel={() => setRemoving(null)}
                            onRemove={async (options) => {
                              await onRemoveProject(row.projectId, options);
                              setRemoving(null);
                              refetch();
                            }}
                          />
                        )}
                        {open.has(key) && <ProcessList rows={view.trees.get(key) ?? []} onStop={(process) => void stopProcess("worktrees", process)} stopping={stopping} />}
                      </div>
                    </Detail>
                  )}
                </Fragment>
              );
            })}
          </DataTable>
        )}
      </section>

      <section aria-labelledby="monitoring-portal">
        <SectionTitle id="monitoring-portal">Portal</SectionTitle>
        <ScopedError>{errorIn("portal")}</ScopedError>
        {view.portal.length === 0 ? (
          <Empty>Portal&apos;s own processes could not be read.</Empty>
        ) : (
          <ProcessTable label="Portal processes" rows={view.portal} roleOf={(process) => (process.owner.kind === "portal" ? portalRoleLabels[process.owner.role] : "")} onStop={(process) => void stopProcess("portal", process)} stopping={stopping} />
        )}
      </section>

      <section aria-labelledby="monitoring-other">
        <SectionTitle id="monitoring-other">Other processes</SectionTitle>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">The largest processes Portal did not start. Listed for reference; Portal does not stop them.</p>
        {view.others.length === 0 ? <Empty>None.</Empty> : <ProcessTable label="Other processes" rows={view.others} stopping={null} />}
      </section>

      <section aria-labelledby="monitoring-disk" className="space-y-4">
        <SectionTitle
          id="monitoring-disk"
          actions={
            <>
              <span className="mr-1 text-[11px] text-muted-foreground">{measuredText(snapshot.disk, view.at)}</span>
              <Button type="button" size="xs" variant="ghost" disabled={refreshing || snapshot.disk.running} onClick={() => void refreshDisk()}>
                {refreshing || snapshot.disk.running ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
                Refresh
              </Button>
            </>
          }
        >
          Disk
        </SectionTitle>
        <ScopedError>{errorIn("disk")}</ScopedError>
        <DataTable label="Volumes" head={["Volume", "Free", "Total", "Used"]}>
          {(snapshot.sample?.volumes ?? []).map((volume, index) => {
            const used = volume.totalBytes > 0 ? 1 - volume.freeBytes / volume.totalBytes : 0;
            const level = index === 0 ? snapshot.diskLevel ?? "normal" : "normal";
            return (
              <Row key={volume.path} label={volume.path}>
                <Cell label="Volume" className="font-mono text-[11px]">{volume.path}</Cell>
                <Cell label="Free" className={`tabular-nums ${level === "critical" ? "text-rose-300" : level === "warning" ? "text-amber-200" : ""}`}>{formatBytes(volume.freeBytes)}</Cell>
                <Cell label="Total" className="tabular-nums">{formatBytes(volume.totalBytes)}</Cell>
                <Cell label="Used" className="w-1/3">
                  <span className="flex w-full items-center gap-2 max-sm:w-40">
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/8">
                      <span className={`block h-full rounded-full ${level === "critical" ? "bg-rose-400" : level === "warning" ? "bg-amber-300" : "bg-foreground/50"}`} style={{ width: `${Math.round(used * 100)}%` }} />
                    </span>
                    <span className="w-9 text-right tabular-nums text-muted-foreground">{Math.round(used * 100)} %</span>
                  </span>
                </Cell>
              </Row>
            );
          })}
        </DataTable>

        {!survey ? (
          <Loading>{snapshot.disk.running ? "Measuring folders…" : "Folders not measured yet."}</Loading>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <h3 className="mb-2 text-xs font-medium text-muted-foreground">Portal&apos;s home <span className="font-mono text-[10px]">{survey.home.path}</span></h3>
              <SizeList label="Portal's home" rows={homeSplit(survey).map((part) => ({ name: part.label, bytes: part.bytes }))} />
              {survey.strayWorktrees.length > 0 && (
                <>
                  <h4 className="mt-3 mb-1.5 text-[11px] text-muted-foreground">Worktree folders no project uses</h4>
                  <SizeList label="Stray worktree folders" rows={survey.strayWorktrees.map((entry) => ({ name: entry.path, bytes: entry.bytes, mono: true }))} />
                </>
              )}
            </div>
            <div>
              <h3 className="mb-2 text-xs font-medium text-muted-foreground">
                Database {survey.database && <span className="text-foreground/80">· {formatBytes(survey.database.bytes)}</span>}
              </h3>
              {survey.database ? (
                <SizeList label="Largest tables" rows={survey.database.tables.slice(0, 5).map((table) => ({ name: table.name, bytes: table.bytes, mono: true }))} />
              ) : (
                <Empty>The database could not be asked.</Empty>
              )}
            </div>
          </div>
        )}

        {survey && (
          <div>
            <h3 className="mb-2 text-xs font-medium text-muted-foreground">Watched folders</h3>
            {survey.watched.length === 0 ? (
              <Empty>No watched folders. Add some in Settings › Monitoring to see their sizes here.</Empty>
            ) : (
              <div className="space-y-2">
                {survey.watched.map((folder) => {
                  const key = `f:${folder.path}`;
                  return (
                    <div key={folder.path} aria-label={folder.path} role="group" className="rounded-2xl border border-white/8 bg-white/[.02] px-3.5 py-2.5 text-xs">
                      <div className="flex items-center gap-2">
                        <ExpandButton open={open.has(key)} onToggle={() => toggle(key)} label={`Largest items in ${folder.path}`}>
                          <span className="font-mono text-[11px]">{folder.path}</span>
                        </ExpandButton>
                        {!folder.exists && <Badge tone="amber"><FolderX className="size-3" />Missing</Badge>}
                        <span className="ml-auto tabular-nums">{formatBytes(folder.bytes)}</span>
                      </div>
                      {open.has(key) && folder.children.length > 0 && (
                        <ul className="mt-2 divide-y divide-white/5">
                          {folder.children.map((child) => (
                            <li key={child.name} className="flex items-center gap-3 py-1 text-[11px]">
                              <span className="min-w-0 flex-1 truncate font-mono">{child.name}</span>
                              <span className="text-muted-foreground">{child.modifiedAt ? new Date(child.modifiedAt).toLocaleDateString() : "—"}</span>
                              <span className="w-16 text-right tabular-nums">{formatBytes(child.bytes)}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Sizes are measured with <code className="font-mono">du</code>, so files shared through APFS clones or hard links are counted in each place they appear.
        </p>
      </section>
    </ViewBody>
  );
}

/** Where an action's error shows: the section the action was taken in. */
type ActionScope = "sessions" | "worktrees" | "portal" | "disk";
type ActionError = { scope: ActionScope; message: string };

/** An action's error under its section's title. */
function ScopedError({ children }: { children: string | null }) {
  if (!children) return null;
  return <div className="mb-2"><ErrorLine>{children}</ErrorLine></div>;
}

function SizeList({ label, rows }: { label: string; rows: { name: string; bytes: number | null; mono?: boolean }[] }) {
  return (
    <ul aria-label={label} className="divide-y divide-white/5 rounded-2xl border border-white/8 bg-white/[.02]">
      {rows.map((row) => (
        <li key={row.name} className="flex items-center gap-3 px-3.5 py-1.5 text-xs">
          <span className={`min-w-0 flex-1 truncate ${row.mono ? "font-mono text-[11px]" : ""}`} title={row.name}>{row.name}</span>
          <span className="tabular-nums">{formatBytes(row.bytes)}</span>
        </li>
      ))}
    </ul>
  );
}
