/** Shared ACP transport, session ownership, and replayable event logs. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentDefinition } from "./agents";
import type { PortalEvent, SessionMeta, SessionState } from "./types";

export type Session = SessionMeta & {
  events: PortalEvent[];
  listeners: Set<(index: number, event: PortalEvent) => void>;
  /** Notified with the replacement `state` after every agent-side state change. */
  stateListeners: Set<(state: SessionState) => void>;
  /** Request IDs of permission prompts the agent is still waiting on. Server-only. */
  pendingPermissions: Set<string>;
};

type AgentProcess = {
  agent: AgentDefinition;
  proc: ChildProcessWithoutNullStreams;
  conn: acp.ClientConnection;
  ready: Promise<void>;
  initialized: boolean;
  failure: Error | null;
  sessions: Map<string, Session>;
};

type PendingPermission = {
  session: Session;
  options: acp.PermissionOption[];
  resolve: (response: acp.RequestPermissionResponse) => void;
};

function emit(session: Session, event: PortalEvent) {
  const index = session.events.push(event) - 1;
  for (const listener of session.listeners) listener(index, event);
}

function selectHasValue(option: Extract<acp.SessionConfigOption, { type: "select" }>, value: string): boolean {
  return option.options.some((entry) =>
    "group" in entry ? entry.options.some((choice) => choice.value === value) : entry.value === value,
  );
}

function setState(session: Session, patch: Partial<SessionState>): SessionState {
  session.state = { ...session.state, ...patch };
  for (const listener of session.stateListeners) listener(session.state);
  return session.state;
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

export function createAcpRuntime(
  agentDefinitions: readonly AgentDefinition[],
  { initializeTimeoutMs = 30_000 }: { initializeTimeoutMs?: number } = {},
) {
  const definitions = new Map(agentDefinitions.map((agent) => [agent.id, agent]));
  const processes = new Map<string, AgentProcess>();
  const sessions = new Map<string, Session>();
  // Upstream IDs are scoped to one process; only Portal IDs leave this module.
  const owners = new WeakMap<Session, { process: AgentProcess; upstreamId: string }>();
  // Open permission prompts by request ID. Answered by any viewer, or cancelled when the turn ends.
  const pending = new Map<string, PendingPermission>();
  let disposed = false;

  function settlePermission(requestId: string, outcome: acp.RequestPermissionOutcome) {
    const request = pending.get(requestId);
    if (!request) return;
    pending.delete(requestId);
    request.session.pendingPermissions.delete(requestId);
    if (outcome.outcome === "selected") {
      const option = request.options.find((option) => option.optionId === outcome.optionId);
      emit(request.session, {
        type: "permission_response",
        requestId,
        outcome: "selected",
        optionId: outcome.optionId,
        optionName: option?.name ?? outcome.optionId,
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

  function fail(instance: AgentProcess, error: Error) {
    if (instance.failure) return;
    instance.failure = error;
    if (processes.get(instance.agent.id) === instance) processes.delete(instance.agent.id);
    for (const session of instance.sessions.values()) {
      session.busy = false;
      cancelPermissions(session);
      emit(session, {
        type: "error",
        message: `${error.message} Create a new session to continue.`,
      });
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
        env: { ...process.env, ...agent.env },
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
        if (!session || instance.failure) {
          return { outcome: { outcome: "cancelled" as const } };
        }
        // Hold the agent's request open until a viewer answers or the turn is cancelled.
        return new Promise<acp.RequestPermissionResponse>((resolve) => {
          const requestId = randomUUID();
          pending.set(requestId, { session, options: params.options, resolve });
          session.pendingPermissions.add(requestId);
          emit(session, { type: "permission_request", requestId, toolCall: params.toolCall, options: params.options });
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
          default:
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
      failure: null,
      sessions: new Map(),
    };
    processes.set(agent.id, instance);

    proc.stderr.on("data", (data) => process.stderr.write(`[${agent.id}] ${data}`));
    proc.on("error", (error) => fail(instance, agentError(agent, "could not start", error)));
    proc.on("exit", (code, signal) => {
      const error = new Error(`process exited (${signal ?? `code ${code}`})`);
      fail(instance, agentError(agent, instance.initialized ? "disconnected" : "could not start", error));
    });
    conn.signal.addEventListener("abort", () => {
      fail(instance, agentError(agent, instance.initialized ? "disconnected" : "could not initialize", conn.signal.reason));
    }, { once: true });

    const timeout = setTimeout(() => {
      fail(instance, agentError(agent, "could not initialize", "startup timed out"));
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
    }).catch((error: unknown) => {
      const failure = instance.failure ?? agentError(agent, "could not initialize", error);
      fail(instance, failure);
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

  function sessionOwner(id: string) {
    const session = sessions.get(id);
    if (!session) throw new Error("No such session");
    const owner = owners.get(session)!;
    if (owner.process.failure) {
      throw new Error(`${owner.process.agent.name} session is no longer available. Create a new session to continue.`);
    }
    return { session, ...owner };
  }

  function listSessions(): SessionMeta[] {
    return [...sessions.values()]
      .map(({ id, agentId, agentName, cwd, projectId, createdAt, busy, state }) => ({
        id, agentId, agentName, cwd, projectId, createdAt, busy, state,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  function getSession(id: string): Session | undefined {
    return sessions.get(id);
  }

  /** `projectId` is Portal metadata: it is stored on the session and never sent to the agent. */
  async function createSession(cwd: string, agentId = agentDefinitions[0]?.id ?? "", projectId = ""): Promise<Session> {
    const instance = await connect(agentId);
    try {
      const response = await instance.conn.agent.request(acp.methods.agent.session.new, {
        cwd,
        mcpServers: [],
      });
      if (instance.failure) throw instance.failure;
      const session: Session = {
        id: randomUUID(),
        agentId: instance.agent.id,
        agentName: instance.agent.name,
        cwd,
        projectId,
        createdAt: Date.now(),
        busy: false,
        state: {
          modes: response.modes ?? null,
          configOptions: response.configOptions ?? [],
          commands: [],
        },
        events: [],
        listeners: new Set(),
        stateListeners: new Set(),
        pendingPermissions: new Set(),
      };
      sessions.set(session.id, session);
      instance.sessions.set(response.sessionId, session);
      owners.set(session, { process: instance, upstreamId: response.sessionId });
      return session;
    } catch (error) {
      throw instance.failure ?? agentError(instance.agent, "could not create a session", error);
    }
  }

  async function sendPrompt(id: string, text: string): Promise<void> {
    const { session, process: instance, upstreamId } = sessionOwner(id);
    if (session.busy) throw new Error("Session busy");
    // Claim the turn before yielding so concurrent requests cannot both start it.
    session.busy = true;
    emit(session, { type: "user", text });
    emit(session, { type: "turn_start" });

    // The route returns immediately; subscribers receive the turn via its event log.
    void instance.conn.agent.request(acp.methods.agent.session.prompt, {
      sessionId: upstreamId,
      prompt: [{ type: "text", text }],
    }).then((response) => {
      if (instance.failure) return;
      session.busy = false;
      cancelPermissions(session);
      emit(session, { type: "turn_end", stopReason: response.stopReason });
    }).catch((error: unknown) => {
      if (instance.failure) return; // fail() already ended this session's turn.
      session.busy = false;
      cancelPermissions(session);
      emit(session, { type: "error", message: agentError(instance.agent, "prompt failed", error).message });
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
    settlePermission(requestId, { outcome: "selected", optionId });
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

  function dispose() {
    disposed = true;
    for (const instance of processes.values()) fail(instance, new Error("ACP runtime is stopped."));
  }

  return {
    listSessions, getSession, createSession, sendPrompt, cancel,
    respondPermission, setConfigOption, setMode, dispose,
  };
}
