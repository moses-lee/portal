/**
 * The transcript model: the event log reduced, turn by turn, into the blocks the chat renders.
 * Pure functions so the browser can keep reduced history across session switches and tests can
 * exercise the reducer without React.
 */
import type { PermissionOption, SessionUpdate, ToolCallContent, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { StoredEvent, PermissionAnswerer } from "@portal/contracts/types";

export type PermissionResponse =
  | { outcome: "selected"; optionId: string; optionName: string; by?: PermissionAnswerer; reason?: string }
  | { outcome: "cancelled" };

export type PermissionBlock = {
  kind: "permission";
  requestId: string;
  toolCall: ToolCallUpdate;
  options: PermissionOption[];
  response: PermissionResponse | null;
};

export type ToolBlock = {
  kind: "tool";
  id: string;
  title: string;
  toolKind?: string | null;
  status?: string | null;
  content: ToolCallContent[];
  rawInput?: unknown;
  rawOutput?: unknown;
};
export type Block =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "thought"; text: string }
  | ToolBlock
  | { kind: "plan"; entries: { content: string; status: string }[] }
  | PermissionBlock
  | { kind: "turn_end"; stopReason: string }
  | { kind: "error"; message: string };

export function reduce(events: StoredEvent[]): Block[] {
  const blocks: Block[] = [];
  const tools = new Map<string, ToolBlock>();
  const permissions = new Map<string, PermissionBlock>();
  const last = () => blocks[blocks.length - 1];
  // The server settles every open prompt before it ends a turn, so a request still unanswered when a
  // server-side turn_end or error arrives (a restart cut the turn off) can no longer be answered.
  const closeOpenPermissions = () => {
    for (const b of permissions.values()) if (b.response === null) b.response = { outcome: "cancelled" };
  };
  const appendText = (kind: "assistant" | "thought", text: string) => {
    const l = last();
    if (l && l.kind === kind) l.text += text;
    else blocks.push({ kind, text });
  };
  for (const ev of events) {
    switch (ev.type) {
      case "user":
        blocks.push({ kind: "user", text: ev.text });
        break;
      case "turn_end":
        closeOpenPermissions();
        blocks.push({ kind: "turn_end", stopReason: ev.stopReason });
        break;
      case "error":
        // Client-only notices (negative seq) describe a failed request, not the end of the turn.
        if (ev.seq >= 0) closeOpenPermissions();
        blocks.push({ kind: "error", message: ev.message });
        break;
      case "permission_request": {
        const b: PermissionBlock = { kind: "permission", requestId: ev.requestId, toolCall: ev.toolCall, options: ev.options, response: null };
        permissions.set(ev.requestId, b);
        blocks.push(b);
        break;
      }
      case "permission_response": {
        const b = permissions.get(ev.requestId);
        if (!b) break;
        b.response = ev.outcome === "selected"
          ? { outcome: "selected", optionId: ev.optionId, optionName: ev.optionName, ...(ev.by ? { by: ev.by } : {}), ...(ev.reason ? { reason: ev.reason } : {}) }
          : { outcome: "cancelled" };
        break;
      }
      case "turn_start":
        break;
      case "update": {
        const u: SessionUpdate = ev.update;
        switch (u.sessionUpdate) {
          case "agent_message_chunk":
            if (u.content.type === "text") appendText("assistant", u.content.text);
            break;
          case "agent_thought_chunk":
            if (u.content.type === "text") appendText("thought", u.content.text);
            break;
          case "tool_call": {
            const b: ToolBlock = {
              kind: "tool",
              id: u.toolCallId,
              title: u.title,
              toolKind: u.kind,
              status: u.status ?? "pending",
              content: u.content ?? [],
              rawInput: u.rawInput,
              rawOutput: u.rawOutput,
            };
            tools.set(b.id, b);
            blocks.push(b);
            break;
          }
          case "tool_call_update": {
            const b = tools.get(u.toolCallId);
            if (!b) break;
            if (u.title) b.title = u.title;
            if (u.kind) b.toolKind = u.kind;
            if (u.status) b.status = u.status;
            if (u.content) b.content = u.content;
            if (u.rawInput !== undefined) b.rawInput = u.rawInput;
            if (u.rawOutput !== undefined) b.rawOutput = u.rawOutput;
            break;
          }
          case "plan":
          case "plan_update": {
            const entries = (u as { entries?: { content: string; status: string }[] }).entries ?? [];
            const l = last();
            if (l && l.kind === "plan") l.entries = entries;
            else blocks.push({ kind: "plan", entries });
            break;
          }
          default:
            break;
        }
      }
    }
  }
  return blocks;
}

/** One turn of the transcript: a `user` event and everything the agent did in response. */
export type Turn = { key: number; events: StoredEvent[]; blocks: Block[] };

/**
 * The loaded part of the log, reduced turn by turn. Pages start at turn boundaries and tool,
 * plan, and permission updates only ever refer to their own turn, so a live event re-reduces
 * only the last turn and an older page only adds turns in front.
 */
export type History = { turns: Turn[]; hasMore: boolean };

export function segment(events: StoredEvent[]): Turn[] {
  const turns: Turn[] = [];
  for (const event of events) {
    const current = turns.at(-1);
    if (current && event.type !== "user") current.events.push(event);
    else turns.push({ key: event.seq, events: [event], blocks: [] });
  }
  for (const turn of turns) turn.blocks = reduce(turn.events);
  return turns;
}

export function appendEvent({ turns, hasMore }: History, event: StoredEvent): History {
  const current = turns.at(-1);
  if (!current || event.type === "user") return { turns: [...turns, { key: event.seq, events: [event], blocks: reduce([event]) }], hasMore };
  const events = [...current.events, event];
  return { turns: [...turns.slice(0, -1), { ...current, events, blocks: reduce(events) }], hasMore };
}

export const firstSeq = ({ turns }: History) => turns[0]?.events[0]?.seq;
export const lastSeq = ({ turns }: History) => turns.at(-1)?.events.at(-1)?.seq;
