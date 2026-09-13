/**
 * ACP layer: owns one long-lived `claude-agent-acp` subprocess and a set of
 * sessions. Each session keeps an append-only event log so any number of
 * SSE subscribers can replay + tail it.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
  StopReason,
} from "@agentclientprotocol/sdk";

export type PortalEvent =
  | { type: "update"; update: SessionUpdate }
  | { type: "user"; text: string }
  | { type: "turn_start" }
  | { type: "turn_end"; stopReason: StopReason }
  | { type: "permission"; title: string; optionId: string; optionName: string }
  | { type: "error"; message: string };

export type Session = {
  id: string;
  cwd: string;
  createdAt: number;
  busy: boolean;
  events: PortalEvent[];
  listeners: Set<(index: number, ev: PortalEvent) => void>;
};

type State = {
  proc: ChildProcessWithoutNullStreams | null;
  conn: acp.ClientConnection | null;
  connecting: Promise<acp.ClientConnection> | null;
  sessions: Map<string, Session>;
};

// Persist across Next.js dev HMR reloads.
const g = globalThis as unknown as { __portalAcp?: State };
const state: State =
  g.__portalAcp ?? (g.__portalAcp = { proc: null, conn: null, connecting: null, sessions: new Map() });

function emit(session: Session, ev: PortalEvent) {
  const index = session.events.push(ev) - 1;
  for (const l of session.listeners) l(index, ev);
}

function pickAutoApprove(req: RequestPermissionRequest): RequestPermissionResponse {
  const prefer = ["allow_always", "allow_once"];
  const opt =
    prefer.map((k) => req.options.find((o) => o.kind === k)).find(Boolean) ?? req.options[0];
  if (!opt) return { outcome: { outcome: "cancelled" } };
  return { outcome: { outcome: "selected", optionId: opt.optionId } };
}

function agentBinPath(): string {
  // Plain path (not require.resolve): Turbopack rewrites resolved package paths.
  return path.join(process.cwd(), "node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js");
}

async function connect(): Promise<acp.ClientConnection> {
  if (state.conn) return state.conn;
  if (state.connecting) return state.connecting;

  state.connecting = (async () => {
    const proc = spawn(process.execPath, [agentBinPath()], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    proc.stderr.on("data", (d) => process.stderr.write(`[claude-agent-acp] ${d}`));
    proc.on("exit", (code, signal) => {
      console.error(`[portal] agent exited code=${code} signal=${signal}`);
      state.proc = null;
      state.conn = null;
      for (const s of state.sessions.values()) {
        if (s.busy) {
          s.busy = false;
          emit(s, { type: "error", message: "Agent process exited" });
        }
      }
    });

    const stream = acp.ndJsonStream(
      Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>,
    );

    const conn = acp
      .client({ name: "portal" })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
        const s = state.sessions.get(ctx.params.sessionId);
        const res = pickAutoApprove(ctx.params);
        if (s && res.outcome.outcome === "selected") {
          const chosenId = res.outcome.optionId;
          const opt = ctx.params.options.find((o) => o.optionId === chosenId);
          emit(s, {
            type: "permission",
            title: ctx.params.toolCall.title ?? "tool call",
            optionId: chosenId,
            optionName: opt?.name ?? "auto-approved",
          });
        }
        return res;
      })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        const s = state.sessions.get(ctx.params.sessionId);
        if (s) emit(s, { type: "update", update: ctx.params.update });
      })
      .connect(stream);

    await conn.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: "portal", version: "0.1.0" },
      clientCapabilities: {},
    });

    state.proc = proc;
    state.conn = conn;
    return conn;
  })();

  try {
    return await state.connecting;
  } finally {
    state.connecting = null;
  }
}

export function listSessions(): Omit<Session, "events" | "listeners">[] {
  return [...state.sessions.values()]
    .map(({ id, cwd, createdAt, busy }) => ({ id, cwd, createdAt, busy }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function getSession(id: string): Session | undefined {
  return state.sessions.get(id);
}

export async function createSession(cwd: string): Promise<Session> {
  const conn = await connect();
  const res = await conn.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
  const session: Session = {
    id: res.sessionId,
    cwd,
    createdAt: Date.now(),
    busy: false,
    events: [],
    listeners: new Set(),
  };
  state.sessions.set(session.id, session);
  return session;
}

export async function sendPrompt(id: string, text: string): Promise<void> {
  const session = state.sessions.get(id);
  if (!session) throw new Error("no such session");
  if (session.busy) throw new Error("session busy");
  const conn = await connect();

  session.busy = true;
  emit(session, { type: "user", text });
  emit(session, { type: "turn_start" });

  // Fire and forget: the turn's progress is streamed via the event log.
  void conn.agent
    .request(acp.methods.agent.session.prompt, {
      sessionId: id,
      prompt: [{ type: "text", text }],
    })
    .then((res) => emit(session, { type: "turn_end", stopReason: res.stopReason }))
    .catch((err: unknown) =>
      emit(session, { type: "error", message: err instanceof Error ? err.message : String(err) }),
    )
    .finally(() => {
      session.busy = false;
    });
}

export async function cancel(id: string): Promise<void> {
  const conn = await connect();
  await conn.agent.notify(acp.methods.agent.session.cancel, { sessionId: id });
}
