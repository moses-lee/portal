/** Shared ACP transport, session ownership, and replayable event logs. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentDefinition } from "./agents";
import type { PortalEvent, SessionMeta } from "./types";

export type Session = SessionMeta & {
  events: PortalEvent[];
  listeners: Set<(index: number, event: PortalEvent) => void>;
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

function emit(session: Session, event: PortalEvent) {
  const index = session.events.push(event) - 1;
  for (const listener of session.listeners) listener(index, event);
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

function pickAutoApprove(req: acp.RequestPermissionRequest): acp.RequestPermissionResponse {
  const option =
    req.options.find((option) => option.kind === "allow_always") ??
    req.options.find((option) => option.kind === "allow_once") ??
    req.options[0];
  return option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } };
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
  let disposed = false;

  function fail(instance: AgentProcess, error: Error) {
    if (instance.failure) return;
    instance.failure = error;
    if (processes.get(instance.agent.id) === instance) processes.delete(instance.agent.id);
    for (const session of instance.sessions.values()) {
      session.busy = false;
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
        const response = pickAutoApprove(params);
        if (response.outcome.outcome === "selected") {
          const optionId = response.outcome.optionId;
          const option = params.options.find((option) => option.optionId === optionId);
          emit(session, {
            type: "permission",
            title: params.toolCall.title ?? "tool call",
            optionId,
            optionName: option?.name ?? "auto-approved",
          });
        }
        return response;
      })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        const session = instance.sessions.get(params.sessionId);
        if (session && !instance.failure) emit(session, { type: "update", update: params.update });
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
      clientCapabilities: {},
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
      .map(({ id, agentId, agentName, cwd, createdAt, busy }) => ({
        id, agentId, agentName, cwd, createdAt, busy,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  function getSession(id: string): Session | undefined {
    return sessions.get(id);
  }

  async function createSession(cwd: string, agentId = agentDefinitions[0]?.id ?? ""): Promise<Session> {
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
        createdAt: Date.now(),
        busy: false,
        events: [],
        listeners: new Set(),
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
      emit(session, { type: "turn_end", stopReason: response.stopReason });
    }).catch((error: unknown) => {
      if (instance.failure) return; // fail() already ended this session's turn.
      session.busy = false;
      emit(session, { type: "error", message: agentError(instance.agent, "prompt failed", error).message });
    });
  }

  async function cancel(id: string): Promise<void> {
    const { process: instance, upstreamId } = sessionOwner(id);
    await instance.conn.agent.notify(acp.methods.agent.session.cancel, { sessionId: upstreamId });
  }

  function dispose() {
    disposed = true;
    for (const instance of processes.values()) fail(instance, new Error("ACP runtime is stopped."));
  }

  return { listSessions, getSession, createSession, sendPrompt, cancel, dispose };
}
