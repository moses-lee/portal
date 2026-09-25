/** Shared ACP transport, session ownership, and persisted, replayable event logs. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentDefinition } from "./agents.ts";
import { childEnv } from "./child-env.ts";
import { DEFAULT_HUNG_AFTER_MS, type ProbeState, createProbeState, deriveLiveness, resetProbe, sampleProbe, trackToolCall } from "./liveness.ts";
import { type ProcessTable, readProcessTable } from "./process-probe.ts";
import { coalesceTextChunks, readTurnPage } from "./session-pages.ts";
import { createMemorySessionStore, type SessionRecord, type SessionStore } from "../sessions/store.ts";
import type {
  EventPage, OpenToolCall, PermissionAnswerer, PortalEvent, SessionLink, SessionListPatch, SessionLiveness, SessionLoss, SessionMeta, SessionState, StoredEvent,
} from "./types.ts";

/** What the runtime tells list subscribers (`onSessionsChange`): a session appeared, changed, or went away. */
export type SessionListChange =
  | { type: "created"; session: SessionMeta }
  | { type: "updated"; id: string; patch: SessionListPatch }
  | { type: "deleted"; id: string };

export type Session = Omit<SessionMeta, "awaitingPermission" | "liveness"> & {
  /** The most recent events, oldest first; `eventBase` is the seq of `events[0]`. Older events live in the store. */
  events: PortalEvent[];
  /** Epoch ms timestamps parallel to `events`. */
  eventTimes: number[];
  eventBase: number;
  /** Seq the next event will get. */
  nextSeq: number;
  /** The agent's own session ID. Server-only. */
  upstreamId: string;
  listeners: Set<(seq: number, event: PortalEvent) => void>;
  /** Notified with the replacement `state` after every agent-side state change. */
  stateListeners: Set<(state: SessionState) => void>;
  /** Notified with the replacement `link` whenever the agent connection changes. */
  linkListeners: Set<(link: SessionLink) => void>;
  /** Notified once when the session is deleted. */
  closeListeners: Set<() => void>;
  /** Request IDs of permission prompts the agent is still waiting on. Server-only. */
  pendingPermissions: Set<string>;
  /** Store writes issued so far; awaited before reading pages so they include the newest events. */
  writes: Promise<void>;
  /** True while `session/load` replays history the store already holds. */
  replaying: boolean;
  process: AgentProcess | null;
  attaching: Promise<void> | null;
  /** The title of the tool the oldest open permission request is about. */
  permissionTitle: string | null;
  /** When the open turn started; null between turns. */
  turnStartedAt: number | null;
  /** Tool calls of the open turn that have not finished, by tool call ID. */
  openTools: Map<string, OpenToolCall>;
  /** The last output of the open turn (heartbeats excluded). */
  lastOutputAt: number | null;
  probe: ProbeState;
  /** Why the agent was lost; persisted, and cleared once it is attached again. */
  lost: SessionLoss | null;
  /** The runtime's liveness settings, shared by all its sessions. */
  livenessConfig: LivenessConfig;
};

/** Liveness settings; `setLivenessOptions` changes them for every session at once. */
export type LivenessConfig = { hungAfterMs: number };

type AgentProcess = {
  agent: AgentDefinition;
  proc: ChildProcessWithoutNullStreams;
  conn: acp.ClientConnection;
  ready: Promise<void>;
  initialized: boolean;
  capabilities: acp.AgentCapabilities;
  failure: Error | null;
  /** The loss recorded on the sessions this process dropped, so a later exit status can refine it. */
  loss: SessionLoss | null;
  /** By upstream (agent-side) session ID. */
  sessions: Map<string, Session>;
};

type PendingPermission = {
  session: Session;
  title: string | null;
  options: acp.PermissionOption[];
  resolve: (response: acp.RequestPermissionResponse) => void;
};

/** What the advisor sees of a permission request. */
export type PermissionRequestView = { sessionId: string; requestId: string; toolCall: acp.RequestPermissionRequest["toolCall"]; options: acp.PermissionOption[] };
/** Portal's answer to a request, with the reason shown in the transcript. */
export type PermissionAdvice = { optionId: string; reason: string };
/**
 * Asked for every permission request before a viewer sees it answered: an advice settles the
 * request as answered by Portal (the request and the answer still reach the transcript); null
 * leaves it for a viewer. Errors count as null.
 */
export type PermissionAdvisor = (request: PermissionRequestView) => Promise<PermissionAdvice | null>;

/** Who answered, for the transcript and the audit trail. */
type Answered = { by: PermissionAnswerer; reason?: string };

const TITLE_LENGTH = 80;

function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1)}…` : line;
}

function selectHasValue(option: Extract<acp.SessionConfigOption, { type: "select" }>, value: string): boolean {
  return option.options.some((entry) =>
    "group" in entry ? entry.options.some((choice) => choice.value === value) : entry.value === value,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function agentError(agent: AgentDefinition, action: string, error: unknown) {
  const detail = errorMessage(error);
  let hint = "";
  if (
    (error instanceof acp.RequestError && error.code === -32000) ||
    /\b(authentication|unauthorized|unauthenticated|log[ -]?in|sign[ -]?in|(?:missing|invalid|expired) (?:credentials|api key|token))\b/i.test(detail)
  ) {
    hint = agent.authHint;
  } else if (action === "could not start" || action === "could not initialize") {
    hint = "Check the agent executable and ACP adapter installation on the machine running Portal.";
  }
  return new Error(`${agent.name} ${action}: ${detail}${hint ? `. ${hint}` : ""}`);
}

/** Whether the session's agent is dead, blocked, busy, hung, or idle, as of `now`. */
export function livenessOf(session: Session, now = Date.now()): SessionLiveness {
  return deriveLiveness({
    now,
    link: session.link.status,
    awaitingPermission: session.pendingPermissions.size > 0,
    permissionTitle: session.permissionTitle,
    turnOpen: session.busy,
    turnStartedAt: session.turnStartedAt,
    openTools: [...session.openTools.values()].map((call) => ({ ...call })),
    lastOutputAt: session.lastOutputAt,
    probe: session.process && !session.process.failure ? session.probe : null,
    lost: session.lost,
    hungAfterMs: session.livenessConfig.hungAfterMs,
  });
}

/** The session's browser-facing metadata, without the runtime's own bookkeeping. */
export function toMeta(session: Session): SessionMeta {
  const { id, agentId, agentName, cwd, projectId, createdAt, lastActiveAt, title, busy, link, state } = session;
  return {
    id, agentId, agentName, cwd, projectId, createdAt, lastActiveAt, title, busy, awaitingPermission: session.pendingPermissions.size > 0, link, state,
    liveness: livenessOf(session),
  };
}

/**
 * A turn is open when the most recent turn marker is its start: `turn_end` and `error` close a
 * turn, while updates such as usage reports may trail either. Returns null when `tail` holds no
 * marker at all, so the caller can look further back.
 */
function turnOpen(tail: readonly PortalEvent[]): boolean | null {
  for (let i = tail.length - 1; i >= 0; i--) {
    const { type } = tail[i];
    if (type === "turn_start" || type === "user") return true;
    if (type === "turn_end" || type === "error") return false;
  }
  return null;
}

/** Callbacks for one viewer of a session; see `subscribe`. */
export type SessionSubscriber = {
  /** Each new log event with its seq. */
  onEvent?: (seq: number, event: PortalEvent) => void;
  /** The replacement agent-side state after every change. */
  onState?: (state: SessionState) => void;
  /** The replacement link on every connection change, and after a title change. */
  onLink?: (link: SessionLink) => void;
  /** Once, when the session is deleted. */
  onClose?: () => void;
};

export type AcpRuntimeOptions = {
  initializeTimeoutMs?: number;
  /** How long a delete waits for the agent to acknowledge cancel/close before moving on. */
  agentCallTimeoutMs?: number;
  /** Where sessions and their logs are persisted; defaults to memory (nothing survives the process). */
  store?: SessionStore;
  /** How many recent events each session keeps in memory for live streams. */
  recentEvents?: number;
  /** How long an open turn may show no CPU and no output before it counts as hung. */
  hungAfterMs?: number;
  /** How often the process probe samples while a turn is open; 0 turns the timer off (tests sample by hand). */
  probeEveryMs?: number;
  /** Reads the process table; tests pass a fake. */
  readProcesses?: () => Promise<ProcessTable | null>;
};

/** How often the probe samples while any turn is open. */
export const PROBE_EVERY_MS = 30_000;
/** An on-demand probe reuses a sample this fresh. */
const PROBE_FRESH_MS = 5_000;

export function createAcpRuntime(
  agentDefinitions: readonly AgentDefinition[],
  {
    initializeTimeoutMs = 30_000, agentCallTimeoutMs = 5_000, store = createMemorySessionStore(), recentEvents = 2_000,
    hungAfterMs = DEFAULT_HUNG_AFTER_MS, probeEveryMs = PROBE_EVERY_MS, readProcesses = readProcessTable,
  }: AcpRuntimeOptions = {},
) {
  const livenessConfig: LivenessConfig = { hungAfterMs };
  const definitions = new Map(agentDefinitions.map((agent) => [agent.id, agent]));
  const processes = new Map<string, AgentProcess>();
  let advisor: PermissionAdvisor | null = null;
  const sessions = new Map<string, Session>();
  // Capabilities announced by the last process of each agent, so an agent known not to support
  // resuming is not restarted just to be asked again.
  const knownCapabilities = new Map<string, acp.AgentCapabilities>();
  // Open permission prompts by request ID. Answered by any viewer, or cancelled when the turn ends.
  const pending = new Map<string, PendingPermission>();
  const listListeners = new Set<(change: SessionListChange) => void>();
  let disposed = false;

  function toListPatch(session: Session): SessionListPatch {
    const { busy, link, title, lastActiveAt } = session;
    return { busy, awaitingPermission: session.pendingPermissions.size > 0, link, title, lastActiveAt };
  }

  function notifyList(change: SessionListChange) {
    for (const listener of listListeners) listener(change);
  }

  /** Tell list subscribers about a change to a session's busy, permission, link, title, or activity fields. */
  function announce(session: Session) {
    if (!current(session)) return;
    notifyList({ type: "updated", id: session.id, patch: toListPatch(session) });
  }

  /** Subscribe to session list changes; returns the unsubscribe function. */
  function onSessionsChange(listener: (change: SessionListChange) => void): () => void {
    listListeners.add(listener);
    return () => { listListeners.delete(listener); };
  }

  function toRecord(session: Session): SessionRecord {
    const { id, agentId, agentName, cwd, projectId, createdAt, lastActiveAt, title, upstreamId, state, lost } = session;
    return { id, agentId, agentName, cwd, projectId, createdAt, lastActiveAt, title, upstreamId, state, lost };
  }

  /** Record (or, with null, clear) why the session's agent was lost. */
  function setLost(session: Session, lost: SessionLoss | null) {
    if (session.lost === lost) return;
    session.lost = lost;
    persistMeta(session);
  }

  function startTurn(session: Session) {
    session.turnStartedAt = Date.now();
    session.openTools.clear();
    session.lastOutputAt = null;
    resetProbe(session.probe);
  }

  function endTurn(session: Session) {
    session.turnStartedAt = null;
    session.openTools.clear();
    session.lastOutputAt = null;
    resetProbe(session.probe);
  }

  /** False once the session has been deleted; nothing about it is written or registered after that. */
  function current(session: Session): boolean {
    return sessions.get(session.id) === session;
  }

  function persistMeta(session: Session) {
    if (!current(session)) return;
    session.writes = session.writes
      .then(() => store.putSession(toRecord(session)))
      .catch((error: unknown) => console.error(`Could not save session ${session.id}: ${errorMessage(error)}`));
  }

  function emit(session: Session, event: PortalEvent) {
    const seq = session.nextSeq++;
    const ts = Date.now();
    session.events.push(event);
    session.eventTimes.push(ts);
    if (session.events.length > recentEvents) {
      const drop = session.events.length - recentEvents;
      session.events.splice(0, drop);
      session.eventTimes.splice(0, drop);
      session.eventBase += drop;
    }
    const stored: StoredEvent = { ...event, seq, ts };
    // A deleted session may still receive its agent's final events; viewers hear them, disk does not.
    if (current(session)) {
      session.writes = session.writes
        .then(() => store.appendEvent(session.id, stored))
        // The store accepts a gap after a failed write, so only this event is lost.
        .catch((error: unknown) => console.error(`Could not save event ${seq} of session ${session.id}: ${errorMessage(error)}`));
    }
    for (const listener of session.listeners) listener(seq, event);
  }

  function setState(session: Session, patch: Partial<SessionState>): SessionState {
    session.state = { ...session.state, ...patch };
    persistMeta(session);
    for (const listener of session.stateListeners) listener(session.state);
    return session.state;
  }

  function setLink(session: Session, link: SessionLink) {
    session.link = link;
    for (const listener of session.linkListeners) listener(link);
    announce(session);
  }

  function settlePermission(requestId: string, outcome: acp.RequestPermissionOutcome, answered?: Answered) {
    const request = pending.get(requestId);
    if (!request) return;
    pending.delete(requestId);
    request.session.pendingPermissions.delete(requestId);
    const [next] = request.session.pendingPermissions;
    request.session.permissionTitle = next ? pending.get(next)?.title ?? null : null;
    announce(request.session);
    if (outcome.outcome === "selected") {
      const option = request.options.find((option) => option.optionId === outcome.optionId);
      emit(request.session, {
        type: "permission_response",
        requestId,
        outcome: "selected",
        optionId: outcome.optionId,
        optionName: option?.name ?? outcome.optionId,
        ...(answered ? { by: answered.by, ...(answered.reason ? { reason: answered.reason } : {}) } : {}),
      });
    } else {
      emit(request.session, { type: "permission_response", requestId, outcome: "cancelled" });
    }
    request.resolve({ outcome });
  }

  function cancelPermissions(session: Session): boolean {
    const open = [...session.pendingPermissions];
    for (const requestId of open) settlePermission(requestId, { outcome: "cancelled" });
    return open.length > 0;
  }

  /** Drop a session's link to its process; the next open or prompt reattaches it. */
  function detach(session: Session, error: string | null) {
    if (session.process) {
      if (session.process.sessions.get(session.upstreamId) === session) session.process.sessions.delete(session.upstreamId);
      session.process = null;
    }
    setLink(session, { status: "offline", error });
  }

  /**
   * Stop using a process: its sessions go offline, each with `loss` recorded as why (nothing is
   * recorded when Portal itself is stopping; the next start marks a cut-off turn instead).
   */
  function fail(instance: AgentProcess, error: Error, loss: Omit<SessionLoss, "at"> | null = null) {
    if (instance.failure) return;
    instance.failure = error;
    instance.loss = loss && !disposed ? { ...loss, at: Date.now() } : null;
    if (processes.get(instance.agent.id) === instance) processes.delete(instance.agent.id);
    for (const session of [...instance.sessions.values()]) {
      const wasBusy = session.busy;
      session.busy = false;
      endTurn(session);
      cancelPermissions(session);
      if (instance.loss) setLost(session, instance.loss);
      detach(session, error.message);
      // On shutdown the log is left as it is; the next start marks the cut-off turn instead.
      if (wasBusy && !disposed) emit(session, { type: "error", message: `${error.message} Send a message to reconnect.` });
    }
    // Closing ACP rejects pending initialize/new/prompt requests immediately.
    instance.conn.close(error);
    instance.proc.kill();
  }

  function startProcess(agent: AgentDefinition): AgentProcess {
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(agent.command, agent.args, {
        cwd: process.cwd(),
        env: { ...childEnv(), ...agent.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw agentError(agent, "could not start", error);
    }

    const stream = acp.ndJsonStream(
      Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>,
    );
    const conn = acp
      .client({ name: "portal" })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        const session = instance.sessions.get(params.sessionId);
        if (!session || instance.failure || session.replaying) {
          return { outcome: { outcome: "cancelled" as const } };
        }
        // Hold the agent's request open until a viewer (or the advisor) answers or the turn is cancelled.
        return new Promise<acp.RequestPermissionResponse>((resolve) => {
          const requestId = randomUUID();
          const title = params.toolCall.title ?? null;
          pending.set(requestId, { session, title, options: params.options, resolve });
          if (session.pendingPermissions.size === 0) session.permissionTitle = title;
          session.pendingPermissions.add(requestId);
          emit(session, { type: "permission_request", requestId, toolCall: params.toolCall, options: params.options });
          announce(session);
          if (advisor) void advise(advisor, { sessionId: session.id, requestId, toolCall: params.toolCall, options: params.options });
        });
      })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        const session = instance.sessions.get(params.sessionId);
        if (!session || instance.failure) return;
        const update = params.update;
        // Agent-side state is replaced rather than logged; viewers receive it via `meta`.
        switch (update.sessionUpdate) {
          case "available_commands_update":
            setState(session, { commands: update.availableCommands });
            return;
          case "current_mode_update":
            setState(session, {
              modes: { ...(session.state.modes ?? { availableModes: [] }), currentModeId: update.currentModeId },
            });
            return;
          case "config_option_update":
            setState(session, { configOptions: update.configOptions });
            return;
          case "session_info_update":
            // Agents that name conversations (Claude Code does) improve on the first-prompt title.
            if (typeof update.title === "string" && update.title.trim() && update.title !== session.title) {
              session.title = update.title.trim();
              persistMeta(session);
              for (const listener of session.linkListeners) listener(session.link);
              announce(session);
            }
            return;
          default:
            // `session/load` replays history Portal already logged; only live updates are appended.
            if (session.replaying) return;
            if (session.busy) {
              const tool = update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update";
              // Tool heartbeats say the agent is alive, not that the tool gets anywhere; everything else is output.
              if (!tool || trackToolCall(session.openTools, update, Date.now())) session.lastOutputAt = Date.now();
            }
            emit(session, { type: "update", update });
        }
      })
      .connect(stream);

    const instance: AgentProcess = {
      agent,
      proc,
      conn,
      ready: Promise.resolve(),
      initialized: false,
      capabilities: {},
      failure: null,
      loss: null,
      sessions: new Map(),
    };
    processes.set(agent.id, instance);

    proc.stderr.on("data", (data) => process.stderr.write(`[${agent.id}] ${data}`));
    proc.on("error", (error) => {
      const failure = agentError(agent, "could not start", error);
      fail(instance, failure, { reason: instance.initialized ? "process_error" : "start_failed", detail: failure.message });
    });
    proc.on("exit", (code, signal) => {
      const error = new Error(`process exited (${signal ?? `code ${code}`})`);
      const exited: Omit<SessionLoss, "at"> = {
        reason: "process_exited",
        detail: signal ? `${agent.name} was killed by ${signal}` : `${agent.name} exited with code ${code}`,
        exitCode: code, signal,
      };
      // The connection usually closes before the exit is reported; the exit says more, so it replaces
      // that loss, unless the exit is only Portal's own SIGTERM after the connection went.
      const previous = instance.loss;
      if (previous?.reason === "connection_closed" && !(proc.killed && signal === "SIGTERM")) {
        const refined = { ...exited, at: previous.at };
        instance.loss = refined;
        for (const session of sessions.values()) if (session.lost === previous) setLost(session, refined);
      }
      fail(instance, agentError(agent, instance.initialized ? "disconnected" : "could not start", error), exited);
    });
    conn.signal.addEventListener("abort", () => {
      const failure = agentError(agent, instance.initialized ? "disconnected" : "could not initialize", conn.signal.reason);
      fail(instance, failure, { reason: "connection_closed", detail: `${agent.name} closed its connection to Portal` });
    }, { once: true });

    const timeout = setTimeout(() => {
      const failure = agentError(agent, "could not initialize", "startup timed out");
      fail(instance, failure, { reason: "start_failed", detail: failure.message });
    }, initializeTimeoutMs);
    instance.ready = conn.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: "portal", version: "0.1.0" },
      // `{}` advertises support; agents may then offer boolean config options.
      clientCapabilities: { session: { configOptions: { boolean: {} } } },
    }).then((response) => {
      if (response.protocolVersion !== acp.PROTOCOL_VERSION) {
        throw new Error(`unsupported ACP protocol version ${response.protocolVersion}`);
      }
      if (instance.failure) throw instance.failure;
      instance.initialized = true;
      instance.capabilities = response.agentCapabilities ?? {};
      knownCapabilities.set(agent.id, instance.capabilities);
    }).catch((error: unknown) => {
      const failure = instance.failure ?? agentError(agent, "could not initialize", error);
      fail(instance, failure, { reason: "start_failed", detail: failure.message });
      throw failure;
    }).finally(() => clearTimeout(timeout));
    return instance;
  }

  async function connect(agentId: string): Promise<AgentProcess> {
    if (disposed) throw new Error("ACP runtime is stopped");
    const agent = definitions.get(agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);
    const instance = processes.get(agentId) ?? startProcess(agent);
    await instance.ready;
    if (instance.failure) throw instance.failure;
    return instance;
  }

  function requireSession(id: string): Session {
    const session = sessions.get(id);
    if (!session) throw new Error("No such session");
    return session;
  }

  /** The session and its live process; throws when the agent is not attached. */
  function sessionOwner(id: string) {
    const session = requireSession(id);
    const instance = session.process;
    if (!instance || instance.failure || session.link.status !== "live") {
      const agent = definitions.get(session.agentId)?.name ?? session.agentName;
      const reason = session.link.status === "offline" && session.link.error ? ` (${session.link.error})` : "";
      throw new Error(`${agent} is not connected to this session${reason}. Send a message to reconnect.`);
    }
    return { session, process: instance, upstreamId: session.upstreamId };
  }

  function makeSession(record: SessionRecord, nextSeq: number, link: SessionLink): Session {
    const session: Session = {
      ...record,
      busy: false,
      link,
      events: [],
      eventTimes: [],
      eventBase: nextSeq,
      nextSeq,
      listeners: new Set(),
      stateListeners: new Set(),
      linkListeners: new Set(),
      closeListeners: new Set(),
      pendingPermissions: new Set(),
      writes: Promise.resolve(),
      replaying: false,
      process: null,
      attaching: null,
      permissionTitle: null,
      turnStartedAt: null,
      openTools: new Map(),
      lastOutputAt: null,
      probe: createProbeState(),
      lost: record.lost ?? null,
      livenessConfig,
    };
    sessions.set(session.id, session);
    return session;
  }

  /** Sessions persisted by an earlier process appear offline; a turn cut off by the restart is closed with an error. */
  async function loadPersisted() {
    await store.ready;
    const records = await store.listSessions();
    await Promise.all(records.map(async (record) => {
      if (sessions.has(record.id)) return;
      const count = await store.eventCount(record.id);
      const session = makeSession(record, count, { status: "offline", error: null });
      // Look back through the tail until a turn marker says whether a turn was cut off.
      let open: boolean | null = null;
      for (let before = count, scanned = 0; open === null && before > 0 && scanned < 5_000;) {
        const { events: tail } = await store.readTail(record.id, { beforeSeq: before, limit: 256 });
        if (tail.length === 0) break;
        open = turnOpen(tail);
        before = tail[0].seq;
        scanned += tail.length;
      }
      if (open) {
        emit(session, { type: "error", message: "Portal restarted while this turn was running. Send a message to continue." });
        setLost(session, { reason: "portal_restarted", detail: "Portal restarted while the turn was running", at: Date.now() });
      }
    }));
  }
  const ready = loadPersisted();

  function listSessions(): SessionMeta[] {
    return [...sessions.values()]
      .map(toMeta)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt || b.createdAt - a.createdAt);
  }

  function getSession(id: string): Session | undefined {
    return sessions.get(id);
  }

  /** `projectId` is Portal metadata: it is stored on the session and never sent to the agent. */
  async function createSession(cwd: string, agentId = agentDefinitions[0]?.id ?? "", projectId = ""): Promise<Session> {
    await ready;
    const instance = await connect(agentId);
    let response: acp.NewSessionResponse;
    try {
      response = await instance.conn.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
      if (instance.failure) throw instance.failure;
    } catch (error) {
      throw instance.failure ?? agentError(instance.agent, "could not create a session", error);
    }
    const now = Date.now();
    const record: SessionRecord = {
      id: randomUUID(),
      agentId: instance.agent.id,
      agentName: instance.agent.name,
      cwd,
      projectId,
      createdAt: now,
      lastActiveAt: now,
      title: null,
      upstreamId: response.sessionId,
      state: {
        modes: response.modes ?? null,
        configOptions: response.configOptions ?? [],
        commands: [],
      },
    };
    const session = makeSession(record, 0, { status: "live" });
    session.process = instance;
    instance.sessions.set(response.sessionId, session);
    try {
      await store.putSession(toRecord(session));
    } catch (error) {
      sessions.delete(session.id);
      instance.sessions.delete(response.sessionId);
      throw new Error(`Could not save the new session: ${errorMessage(error)}`);
    }
    notifyList({ type: "created", session: toMeta(session) });
    return session;
  }

  /**
   * Reattach the agent to a session created by an earlier process (or whose process has since
   * exited) with `session/resume`, falling back to `session/load` with its replay discarded.
   * When the agent no longer knows the session, a never-prompted session gets a fresh upstream
   * session in its place (Claude Code only writes a transcript on the first turn), while one
   * with history fails with a message the user can act on.
   * Resolves immediately for live sessions; concurrent callers share one attempt.
   */
  async function attach(id: string): Promise<void> {
    await ready;
    const session = requireSession(id);
    if (session.process && !session.process.failure && session.link.status === "live") return;
    if (session.attaching) return session.attaching;
    const agent: AgentDefinition = definitions.get(session.agentId)
      ?? { id: session.agentId, name: session.agentName, command: "", args: [], authHint: "" };
    const cannotResume = (capabilities: acp.AgentCapabilities) =>
      !capabilities.sessionCapabilities?.resume && !capabilities.loadSession;
    const isNotFound = (error: unknown) => error instanceof acp.RequestError && error.code === -32002;
    session.attaching = (async () => {
      setLink(session, { status: "connecting" });
      let instance: AgentProcess | null = null;
      try {
        if (!definitions.has(agent.id)) throw new Error(`Unknown agent: ${session.agentId}`);
        const known = knownCapabilities.get(agent.id);
        if (known && cannotResume(known)) throw new Error("this agent cannot resume earlier sessions");
        instance = await connect(agent.id);
        if (!current(session)) throw new Error("the session was deleted");
        if (cannotResume(instance.capabilities)) throw new Error("this agent cannot resume earlier sessions");
        const holder = instance.sessions.get(session.upstreamId);
        if (holder && holder !== session) throw new Error("another session is already attached under this agent session id");
        // Route notifications to this session before the agent starts sending them.
        instance.sessions.set(session.upstreamId, session);
        session.process = instance;
        const params = { sessionId: session.upstreamId, cwd: session.cwd, mcpServers: [] };
        let response: acp.ResumeSessionResponse | acp.LoadSessionResponse | acp.NewSessionResponse | null;
        let replaced = false;
        try {
          if (instance.capabilities.sessionCapabilities?.resume) {
            response = await instance.conn.agent.request(acp.methods.agent.session.resume, params);
          } else {
            session.replaying = true;
            try {
              response = await instance.conn.agent.request(acp.methods.agent.session.load, params);
            } finally {
              session.replaying = false;
            }
          }
        } catch (error) {
          if (!isNotFound(error)) throw error;
          if (instance.failure) throw instance.failure;
          if (!current(session)) throw new Error("the session was deleted");
          if (session.nextSeq > 0) {
            console.warn(`Session ${session.id}: ${agent.name} no longer has agent session ${session.upstreamId}`);
            throw new Error(`${agent.name} no longer has this conversation on the machine running Portal, so it cannot be resumed. Start a new session to continue.`);
          }
          // Nothing was ever said in this session, so a fresh upstream session loses nothing.
          const created = await instance.conn.agent.request(acp.methods.agent.session.new, { cwd: session.cwd, mcpServers: [] });
          if (instance.sessions.get(session.upstreamId) === session) instance.sessions.delete(session.upstreamId);
          session.upstreamId = created.sessionId;
          instance.sessions.set(created.sessionId, session);
          response = created;
          replaced = true;
        }
        if (instance.failure) throw instance.failure;
        if (!current(session)) throw new Error("the session was deleted");
        setState(session, {
          modes: response?.modes ?? session.state.modes,
          configOptions: response?.configOptions ?? session.state.configOptions,
          // The new upstream session announces its own commands.
          ...(replaced ? { commands: [] } : {}),
        });
        setLost(session, null);
        setLink(session, { status: "live" });
      } catch (error) {
        // Startup failures already name the agent; only wrap errors from the resume itself.
        const failure = instance?.failure
          ?? (error instanceof Error && error.message.startsWith(agent.name) ? error : agentError(agent, "could not reconnect", error));
        setLost(session, { reason: "reconnect_failed", detail: failure.message, at: Date.now() });
        detach(session, failure.message);
        throw failure;
      } finally {
        session.attaching = null;
      }
    })();
    return session.attaching;
  }

  async function sendPrompt(id: string, text: string): Promise<void> {
    await ready;
    const target = requireSession(id);
    if (target.busy) throw new Error("Session busy");
    if (target.link.status !== "live") await attach(id);
    const { session, process: instance, upstreamId } = sessionOwner(id);
    if (session.busy) throw new Error("Session busy");
    // Claim the turn before yielding so concurrent requests cannot both start it.
    session.busy = true;
    session.lastActiveAt = Date.now();
    if (session.title === null) session.title = titleFrom(text) || null;
    startTurn(session);
    persistMeta(session);
    announce(session);
    emit(session, { type: "user", text });
    emit(session, { type: "turn_start" });

    // The route returns immediately; subscribers receive the turn via its event log.
    void instance.conn.agent.request(acp.methods.agent.session.prompt, {
      sessionId: upstreamId,
      prompt: [{ type: "text", text }],
    }).then((response) => {
      if (instance.failure) return;
      session.busy = false;
      endTurn(session);
      cancelPermissions(session);
      emit(session, { type: "turn_end", stopReason: response.stopReason });
      announce(session);
    }).catch((error: unknown) => {
      if (instance.failure) return; // fail() already ended this session's turn.
      session.busy = false;
      endTurn(session);
      cancelPermissions(session);
      emit(session, { type: "error", message: agentError(instance.agent, "prompt failed", error).message });
      announce(session);
    });
  }

  async function cancel(id: string): Promise<void> {
    const { session, process: instance, upstreamId } = sessionOwner(id);
    // Release the agent from any open prompt before asking it to stop the turn. The SDK writes
    // those responses on later microtasks, so yield once to keep them ahead of the notification.
    if (cancelPermissions(session)) await new Promise((resolve) => setImmediate(resolve));
    if (instance.failure) throw instance.failure;
    await instance.conn.agent.notify(acp.methods.agent.session.cancel, { sessionId: upstreamId });
  }

  /** Answer an open permission prompt; `optionId: null` cancels it. */
  function respondPermission(id: string, requestId: string, optionId: string | null): void {
    const { session } = sessionOwner(id);
    const request = pending.get(requestId);
    if (!request || request.session !== session) {
      throw new Error("That permission request is no longer open.");
    }
    if (optionId === null) {
      settlePermission(requestId, { outcome: "cancelled" });
      return;
    }
    if (!request.options.some((option) => option.optionId === optionId)) {
      throw new Error(`Unknown permission option: ${optionId}`);
    }
    settlePermission(requestId, { outcome: "selected", optionId }, { by: "user" });
  }

  /** Portal's own answer to a request, when the advisor has one and nobody answered meanwhile. */
  async function advise(current: PermissionAdvisor, request: PermissionRequestView): Promise<void> {
    let advice: PermissionAdvice | null = null;
    try {
      advice = await current(request);
    } catch (error) {
      console.error("The permission advisor failed; the request waits for a viewer:", error);
    }
    const open = pending.get(request.requestId);
    if (!advice || !open || !open.options.some((option) => option.optionId === advice!.optionId)) return;
    settlePermission(request.requestId, { outcome: "selected", optionId: advice.optionId }, { by: "portal", reason: advice.reason });
  }

  /** Install (or remove, with null) the advisor asked about every new permission request. */
  function setPermissionAdvisor(next: PermissionAdvisor | null): void {
    advisor = next;
  }

  async function setConfigOption(id: string, configId: string, value: string | boolean): Promise<SessionState> {
    const { session, process: instance, upstreamId } = sessionOwner(id);
    const params: acp.SetSessionConfigOptionRequest = typeof value === "boolean"
      ? { sessionId: upstreamId, configId, type: "boolean", value }
      : { sessionId: upstreamId, configId, value };
    try {
      const response = await instance.conn.agent.request(acp.methods.agent.session.setConfigOption, params);
      if (instance.failure) throw instance.failure;
      const configOptions = response.configOptions;
      // Some agents expose the session mode as a `mode` config option without also pushing
      // `current_mode_update`; keep the modes view in step when the new value names a known mode.
      const modeOption = configOptions.find((option) => option.category === "mode" && option.type === "select");
      const modeId = modeOption?.currentValue;
      const modes = session.state.modes;
      const syncedModes = modes && typeof modeId === "string"
        && modeId !== modes.currentModeId && modes.availableModes.some((mode) => mode.id === modeId)
        ? { ...modes, currentModeId: modeId }
        : modes;
      return setState(session, { configOptions, modes: syncedModes });
    } catch (error) {
      throw instance.failure ?? agentError(instance.agent, "could not change settings", error);
    }
  }

  async function setMode(id: string, modeId: string): Promise<SessionState> {
    const { session, process: instance, upstreamId } = sessionOwner(id);
    try {
      await instance.conn.agent.request(acp.methods.agent.session.setMode, { sessionId: upstreamId, modeId });
      if (instance.failure) throw instance.failure;
      // Agents may also push `current_mode_update`; both paths converge on the same state. A
      // `mode` config option mirrors the same choice, so keep it in step when it lists this mode.
      const configOptions = session.state.configOptions.map((option) =>
        option.category === "mode" && option.type === "select" && selectHasValue(option, modeId)
          ? { ...option, currentValue: modeId }
          : option,
      );
      return setState(session, {
        modes: { ...(session.state.modes ?? { availableModes: [] }), currentModeId: modeId },
        configOptions,
      });
    } catch (error) {
      throw instance.failure ?? agentError(instance.agent, "could not change settings", error);
    }
  }

  /** One page of the log ending before `before` (default: the newest events), aligned to a turn start. */
  async function readEvents(id: string, { before, limit = 300 }: { before?: number; limit?: number } = {}): Promise<EventPage> {
    await ready;
    const session = requireSession(id);
    // Taken before the read: an event that lands mid-read is either on the page or replayed by the
    // stream from this cursor (viewers drop duplicates), never skipped.
    const nextSeq = session.nextSeq;
    await session.writes;
    const page = await readTurnPage(store, id, { before, minEvents: limit });
    return { events: coalesceTextChunks(page.events), hasMore: page.hasMore, nextSeq };
  }

  /**
   * Events after `since` that are still in memory, or null when they have aged out and the
   * viewer must refetch a page instead.
   */
  function eventsSince(id: string, since: number): StoredEvent[] | null {
    const session = requireSession(id);
    const from = since + 1;
    if (from < session.eventBase) return null;
    const offset = from - session.eventBase;
    return session.events.slice(offset).map((event, i) => ({ ...event, seq: from + i, ts: session.eventTimes[offset + i] }));
  }

  /**
   * Follow one session's live events and metadata changes. Throws for an unknown session; the
   * returned function detaches every callback and is safe to call more than once.
   */
  function subscribe(id: string, { onEvent, onState, onLink, onClose }: SessionSubscriber): () => void {
    const session = requireSession(id);
    if (onEvent) session.listeners.add(onEvent);
    if (onState) session.stateListeners.add(onState);
    if (onLink) session.linkListeners.add(onLink);
    if (onClose) session.closeListeners.add(onClose);
    return () => {
      if (onEvent) session.listeners.delete(onEvent);
      if (onState) session.stateListeners.delete(onState);
      if (onLink) session.linkListeners.delete(onLink);
      if (onClose) session.closeListeners.delete(onClose);
    };
  }

  /** Resolve to `fallback` if `promise` takes longer than `ms`; errors are swallowed too. */
  function settleWithin<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(fallback), ms);
      promise.then((value) => resolve(value), () => resolve(fallback)).finally(() => clearTimeout(timer));
    });
  }

  /** Stop the turn, close the agent's side when it can, and remove the session and its log. */
  async function deleteSession(id: string): Promise<boolean> {
    await ready;
    const session = sessions.get(id);
    if (!session) return false;
    // A reconnect in flight would otherwise register and persist the session again once it finishes.
    if (session.attaching) await session.attaching.catch(() => {});
    if (sessions.get(id) !== session) return false;
    sessions.delete(id);
    cancelPermissions(session);
    const instance = session.process;
    if (instance && !instance.failure) {
      // The agent is told, but a stalled agent must not hold the delete (or the HTTP request) open.
      if (session.busy) {
        await settleWithin(instance.conn.agent.notify(acp.methods.agent.session.cancel, { sessionId: session.upstreamId }), agentCallTimeoutMs, undefined);
      }
      if (instance.capabilities.sessionCapabilities?.close) {
        await settleWithin(instance.conn.agent.request(acp.methods.agent.session.close, { sessionId: session.upstreamId }), agentCallTimeoutMs, null);
      }
    }
    detach(session, null);
    session.busy = false;
    endTurn(session);
    for (const listener of session.closeListeners) listener();
    notifyList({ type: "deleted", id });
    await session.writes;
    await store.deleteSession(id);
    return true;
  }

  /** Sessions whose agent process is attached; only those have a tree to probe. */
  function probeable(session: Session): session is Session & { process: AgentProcess } {
    return !!session.process && !session.process.failure && session.link.status === "live" && typeof session.process.proc.pid === "number";
  }

  let reading: Promise<ProcessTable | null> | null = null;

  /** One `ps` read at a time; callers that arrive meanwhile share it. */
  function readTable(): Promise<ProcessTable | null> {
    reading ??= readProcesses().catch(() => null).finally(() => { reading = null; });
    return reading;
  }

  /**
   * Sample the process tree of `targets`. Concurrent callers share the `ps` read; a platform
   * without `ps` leaves the probes empty, so no session is ever called hung there.
   */
  async function probe(targets: Session[]): Promise<void> {
    if (!targets.some(probeable)) return;
    const table = await readTable();
    if (!table) return;
    for (const session of targets) {
      // The process may have gone while `ps` ran (its sessions were reset then), or another caller sampled this read already.
      if (!probeable(session) || !current(session) || session.probe.last?.sampledAt === table.at) continue;
      sampleProbe(session.probe, table, {
        agentPid: session.process.proc.pid!,
        marker: session.upstreamId,
        turnStartedAt: session.busy ? session.turnStartedAt : null,
      });
    }
  }

  /**
   * The session's liveness with a fresh probe (one taken in the last few seconds is reused).
   * Throws for an unknown session.
   */
  async function probeSession(id: string): Promise<SessionLiveness> {
    const session = requireSession(id);
    const last = session.probe.last?.sampledAt ?? 0;
    if (Date.now() - last > PROBE_FRESH_MS) await probe([session]);
    return livenessOf(session);
  }

  // While any turn is open, sample every session with one: CPU and child processes are only
  // measurable as a change between samples.
  const probeTimer = probeEveryMs > 0
    ? setInterval(() => {
      const busy = [...sessions.values()].filter((session) => session.busy);
      if (busy.length) void probe(busy);
    }, probeEveryMs)
    : null;
  probeTimer?.unref();

  /** Change the liveness settings of every session (the hung threshold comes from the user's settings). */
  function setLivenessOptions(options: Partial<LivenessConfig>): void {
    if (typeof options.hungAfterMs === "number" && options.hungAfterMs > 0) livenessConfig.hungAfterMs = options.hungAfterMs;
  }

  async function dispose() {
    disposed = true;
    if (probeTimer) clearInterval(probeTimer);
    for (const instance of processes.values()) fail(instance, new Error("ACP runtime is stopped."));
    await Promise.all([...sessions.values()].map((session) => session.writes));
    await store.dispose().catch(() => {});
  }

  return {
    ready, listSessions, getSession, createSession, attach, sendPrompt, cancel,
    respondPermission, setPermissionAdvisor, setConfigOption, setMode, readEvents, eventsSince, subscribe, deleteSession, onSessionsChange, dispose,
    probe, probeSession, setLivenessOptions,
  };
}

export type AcpRuntime = ReturnType<typeof createAcpRuntime>;
