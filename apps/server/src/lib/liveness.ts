/**
 * Session liveness: telling an agent that is dead or hung apart from one that is busy (a 45-minute
 * test run looks idle in the transcript). Three inputs meet here, all kept per session by the
 * runtime: the tool calls the agent opened and has not finished (from its event stream), the
 * process probe (the agent's process tree from `ps`: which processes the turn started, and whether
 * they use CPU or come and go), and the last output of the turn. `deriveLiveness` turns them into
 * one state. Everything here is pure; the runtime owns the timers and the `ps` reads.
 */
import type * as acp from "@agentclientprotocol/sdk";
import type { LivenessState, OpenToolCall, SessionLiveness, SessionLoss, SessionProcessProbe } from "@portal/contracts/types";
import { type ProcessRow, type ProcessTable, descendants, findSessionRoot } from "./process-probe.ts";

/** Default for how long a turn may show no CPU and no output before it counts as hung. */
export const DEFAULT_HUNG_AFTER_MS = 15 * 60_000;
/** The span `cpuMs` in a probe covers. */
export const CPU_WINDOW_MS = 5 * 60_000;
/**
 * The share of one core the turn's processes must use between two samples to count as moving.
 * Low on purpose: a test runner waiting on its workers, or a client polling a build server, uses
 * little; a process blocked on a read uses none.
 */
export const CPU_ACTIVE_SHARE = 0.002;
const CPU_ACTIVE_MIN_MS = 10;
/** `etime` has one-second resolution; a process started this close before the turn still counts as the turn's. */
const START_SLACK_MS = 2_000;
/** Children listed per probe. */
const MAX_CHILDREN = 20;
const COMMAND_LENGTH = 200;
const TITLE_LENGTH = 80;

// ---------------------------------------------------------------------------------------------
// Open tool calls
// ---------------------------------------------------------------------------------------------

const FINISHED = new Set(["completed", "failed", "cancelled"]);

function hasOutput(update: acp.ToolCallUpdate): boolean {
  return (Array.isArray(update.content) && update.content.length > 0) || (update.rawOutput !== undefined && update.rawOutput !== null);
}

/**
 * Apply one `tool_call` or `tool_call_update` to the open calls. Returns true when the update is
 * output (a new call, a finished one, content, a result, or a new title): a bare status update
 * that repeats `in_progress` is a heartbeat, which agents send on a timer while a tool runs, so it
 * proves the agent is alive but not that the tool is getting anywhere.
 */
export function trackToolCall(open: Map<string, OpenToolCall>, update: acp.SessionUpdate, now: number): boolean {
  if (update.sessionUpdate === "tool_call") {
    if (update.status && FINISHED.has(update.status)) {
      open.delete(update.toolCallId);
      return true;
    }
    const prior = open.get(update.toolCallId);
    open.set(update.toolCallId, {
      id: update.toolCallId, title: update.title || prior?.title || "tool", kind: update.kind ?? prior?.kind ?? null,
      startedAt: prior?.startedAt ?? now, lastOutputAt: prior?.lastOutputAt ?? null,
    });
    return true;
  }
  if (update.sessionUpdate !== "tool_call_update") return false;
  if (update.status && FINISHED.has(update.status)) {
    open.delete(update.toolCallId);
    return true;
  }
  const call = open.get(update.toolCallId);
  const output = hasOutput(update) || (!!update.title && update.title !== call?.title);
  if (!call) {
    // An update for a call this runtime never saw start (it began before a reconnect): open it now.
    open.set(update.toolCallId, { id: update.toolCallId, title: update.title || "tool", kind: update.kind ?? null, startedAt: now, lastOutputAt: output ? now : null });
    return output;
  }
  if (update.title) call.title = update.title;
  if (update.kind) call.kind = update.kind;
  if (output) call.lastOutputAt = now;
  return output;
}

// ---------------------------------------------------------------------------------------------
// Process probe
// ---------------------------------------------------------------------------------------------

type Sample = { at: number; cpu: Map<number, number>; children: Set<number> };

/** What the runtime keeps per session between probes. */
export type ProbeState = {
  samples: Sample[];
  last: SessionProcessProbe | null;
  /** The last sample that saw the turn's processes use CPU, start, or exit. */
  lastCpuAt: number | null;
};

export function createProbeState(): ProbeState {
  return { samples: [], last: null, lastCpuAt: null };
}

/** Forget what was sampled, as when a turn ends or the agent goes away. */
export function resetProbe(state: ProbeState): void {
  state.samples = [];
  state.last = null;
  state.lastCpuAt = null;
}

export type ProbeTarget = {
  agentPid: number;
  /** A string only the session's own process has on its command line (the agent's session id). */
  marker: string;
  /** Processes started since then (less `START_SLACK_MS`) are the turn's; null when no turn is open. */
  turnStartedAt: number | null;
  windowMs?: number;
};

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** CPU used by `rows` since `base`: a process `base` did not hold counts in full when it started after it. */
function cpuSince(rows: ProcessRow[], base: Sample, at: number): number {
  let total = 0;
  for (const row of rows) {
    const before = base.cpu.get(row.pid);
    if (before !== undefined) total += Math.max(0, row.cpuMs - before);
    else if (at - row.elapsedMs >= base.at - START_SLACK_MS) total += row.cpuMs;
  }
  return total;
}

/** Record one sample of the session's tree from `table` and return the probe it gives. */
export function sampleProbe(state: ProbeState, table: ProcessTable, target: ProbeTarget): SessionProcessProbe {
  const windowMs = target.windowMs ?? CPU_WINDOW_MS;
  const at = table.at;
  const agent = table.rows.get(target.agentPid);
  const sessionRoot = agent ? findSessionRoot(table, target.agentPid, target.marker) : null;
  const rootPid = agent ? (sessionRoot ?? target.agentPid) : null;
  const root = rootPid === null ? undefined : table.rows.get(rootPid);
  const below = rootPid === null ? [] : descendants(table, rootPid);
  const since = target.turnStartedAt;
  const turnRows = since === null ? [] : below.filter((row) => at - row.elapsedMs >= since - START_SLACK_MS);
  const treeRows = root ? [root, ...below] : below;

  const sample: Sample = {
    at,
    cpu: new Map(treeRows.map((row) => [row.pid, row.cpuMs])),
    children: new Set(turnRows.map((row) => row.pid)),
  };
  const previous = state.samples.at(-1);
  if (previous && turnRows.length + previous.children.size > 0) {
    const used = cpuSince(turnRows, previous, at);
    const churn = turnRows.some((row) => !previous.children.has(row.pid)) || [...previous.children].some((pid) => !sample.children.has(pid));
    if (churn || used >= Math.max(CPU_ACTIVE_MIN_MS, (at - previous.at) * CPU_ACTIVE_SHARE)) state.lastCpuAt = at;
  } else if (!previous && turnRows.length > 0) {
    // The first look at a turn that already has processes: they may have just started.
    state.lastCpuAt = Math.max(state.lastCpuAt ?? 0, ...turnRows.map((row) => at - row.elapsedMs));
  }
  state.samples.push(sample);
  // Keep the newest sample at or before the window's start as the baseline, and everything after it.
  const start = at - windowMs;
  let drop = 0;
  while (drop + 1 < state.samples.length && state.samples[drop + 1].at <= start) drop++;
  if (drop) state.samples.splice(0, drop);
  const base = state.samples.length > 1 ? state.samples[0] : null;

  const probe: SessionProcessProbe = {
    agentPid: target.agentPid,
    alive: !!agent,
    scope: sessionRoot !== null ? "session" : "agent",
    rootPid: root ? root.pid : null,
    children: turnRows
      .slice(0, MAX_CHILDREN)
      .map((row) => ({ pid: row.pid, command: clip(row.command, COMMAND_LENGTH), elapsedMs: row.elapsedMs, cpuMs: row.cpuMs })),
    cpuMs: base ? cpuSince(treeRows, base, at) : null,
    childCpuMs: base ? cpuSince(turnRows, base, at) : null,
    windowMs: base ? at - base.at : 0,
    sampledAt: at,
  };
  state.last = probe;
  return probe;
}

// ---------------------------------------------------------------------------------------------
// The derived state
// ---------------------------------------------------------------------------------------------

export type LivenessInput = {
  now: number;
  link: "live" | "connecting" | "offline";
  awaitingPermission: boolean;
  /** The title of the tool the open permission request is about, when known. */
  permissionTitle?: string | null;
  turnOpen: boolean;
  turnStartedAt: number | null;
  openTools: OpenToolCall[];
  lastOutputAt: number | null;
  probe: ProbeState | null;
  lost: SessionLoss | null;
  hungAfterMs: number;
};

/** "45s", "12m", "3h 5m", "2d 4h". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** The oldest open tool call: the one the turn is waiting on. */
function waitingOn(tools: OpenToolCall[]): OpenToolCall | null {
  return tools.reduce<OpenToolCall | null>((oldest, call) => (!oldest || call.startedAt < oldest.startedAt ? call : oldest), null);
}

export function deriveLiveness(input: LivenessInput): SessionLiveness {
  const { now, turnOpen, openTools, lost, hungAfterMs } = input;
  const probe = input.probe?.last ?? null;
  const lastCpuAt = input.probe?.lastCpuAt ?? null;
  const base = {
    turnOpen, turnStartedAt: input.turnStartedAt, openTools, lastOutputAt: input.lastOutputAt, lastCpuAt,
    process: probe, lost, hungAfterMs,
  };
  const result = (state: LivenessState, summary: string): SessionLiveness => ({ state, summary, ...base });

  if (input.link === "offline") {
    if (lost) return result("dead", `dead: ${lost.detail}`);
    return result("idle", "idle (agent not attached)");
  }
  if (input.link === "live" && probe && !probe.alive) return result("dead", "dead: the agent process is gone");
  if (input.awaitingPermission) return result("blocked", `waiting on a permission${input.permissionTitle ? `: ${clip(input.permissionTitle, TITLE_LENGTH)}` : ""}`);
  if (input.link === "connecting") return result("busy", "connecting to the agent");
  if (!turnOpen) return result("idle", "idle");

  const started = input.turnStartedAt ?? now;
  const tool = waitingOn(openTools);
  const doing = tool ? `running tool: ${clip(tool.title, TITLE_LENGTH)} for ${formatDuration(now - tool.startedAt)}` : `working for ${formatDuration(now - started)}`;
  // Without a probe nothing says the processes are quiet, so the turn is never called hung.
  if (!probe) return result("busy", doing);
  const lastSign = Math.max(started, input.lastOutputAt ?? 0, lastCpuAt ?? 0, ...openTools.map((call) => call.lastOutputAt ?? call.startedAt));
  const quiet = now - lastSign;
  if (quiet >= hungAfterMs) {
    return result("hung", `hung: no CPU or output for ${formatDuration(quiet)}${tool ? ` (tool: ${clip(tool.title, TITLE_LENGTH)}, started ${formatDuration(now - tool.startedAt)} ago)` : ""}`);
  }
  return result("busy", doing);
}

/** True for the states that count as a stall. */
export const isStall = (state: LivenessState) => state === "dead" || state === "hung";
