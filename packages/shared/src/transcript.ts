/**
 * The transcript model: the event log reduced, turn by turn, into the blocks the chat renders.
 * Pure functions so the browser can keep reduced history across session switches and tests can
 * exercise the reducer without React. Reduction is incremental: a turn keeps a reducer, and a
 * streamed event updates only the block it touches, as a new object, so memoised renderers of the
 * other blocks are left alone and a long turn costs the same per event at its end as at its start.
 */
import type { PermissionOption, ToolCallContent, ToolCallUpdate } from "@agentclientprotocol/sdk";
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

/**
 * Reduces one turn's events, one at a time. `blocks` is replaced (a new array, changed blocks as
 * new objects) whenever an event changes something. Events at or below `lastSeq` are ignored, so
 * applying one twice is harmless; client-only notices (negative seqs) are always applied and never
 * move the cursor.
 */
export type TurnReducer = {
  readonly blocks: Block[];
  /** The highest logged seq applied; -1 before any. */
  readonly lastSeq: number;
  /** Apply one event; true when `blocks` changed. */
  apply(event: StoredEvent): boolean;
};

export function createTurnReducer(): TurnReducer {
  let blocks: Block[] = [];
  let lastSeq = -1;
  /** Index into `blocks` of each tool call and each open permission prompt, by id. */
  const tools = new Map<string, number>();
  const permissions = new Map<string, number>();

  const replace = (index: number, block: Block) => {
    blocks = blocks.slice();
    blocks[index] = block;
  };
  const push = (block: Block) => {
    blocks = [...blocks, block];
    return blocks.length - 1;
  };
  const last = () => blocks[blocks.length - 1];
  // The server settles every open prompt before it ends a turn, so a request still unanswered when a
  // server-side turn_end or error arrives (a restart cut the turn off) can no longer be answered.
  const closeOpenPermissions = () => {
    for (const index of permissions.values()) {
      const block = blocks[index] as PermissionBlock;
      if (block.response === null) replace(index, { ...block, response: { outcome: "cancelled" } });
    }
  };
  const appendText = (kind: "assistant" | "thought", text: string) => {
    const l = last();
    if (l && l.kind === kind) replace(blocks.length - 1, { kind, text: l.text + text });
    else push({ kind, text });
  };

  function reduceOne(ev: StoredEvent): boolean {
    switch (ev.type) {
      case "user":
        push({ kind: "user", text: ev.text });
        return true;
      case "turn_end":
        closeOpenPermissions();
        push({ kind: "turn_end", stopReason: ev.stopReason });
        return true;
      case "error":
        // Client-only notices (negative seq) describe a failed request, not the end of the turn.
        if (ev.seq >= 0) closeOpenPermissions();
        push({ kind: "error", message: ev.message });
        return true;
      case "permission_request": {
        const index = push({ kind: "permission", requestId: ev.requestId, toolCall: ev.toolCall, options: ev.options, response: null });
        permissions.set(ev.requestId, index);
        return true;
      }
      case "permission_response": {
        const index = permissions.get(ev.requestId);
        if (index === undefined) return false;
        const block = blocks[index] as PermissionBlock;
        const response: PermissionResponse = ev.outcome === "selected"
          ? { outcome: "selected", optionId: ev.optionId, optionName: ev.optionName, ...(ev.by ? { by: ev.by } : {}), ...(ev.reason ? { reason: ev.reason } : {}) }
          : { outcome: "cancelled" };
        replace(index, { ...block, response });
        return true;
      }
      case "turn_start":
        return false;
      case "update": {
        // Background task starts and ends (`async_task_*`) are logged here too; they add no block yet.
        const u = ev.update;
        switch (u.sessionUpdate) {
          case "agent_message_chunk":
            if (u.content.type !== "text") return false;
            appendText("assistant", u.content.text);
            return true;
          case "agent_thought_chunk":
            if (u.content.type !== "text") return false;
            appendText("thought", u.content.text);
            return true;
          case "tool_call": {
            const index = push({
              kind: "tool",
              id: u.toolCallId,
              title: u.title,
              toolKind: u.kind,
              status: u.status ?? "pending",
              content: u.content ?? [],
              rawInput: u.rawInput,
              rawOutput: u.rawOutput,
            });
            tools.set(u.toolCallId, index);
            return true;
          }
          case "tool_call_update": {
            const index = tools.get(u.toolCallId);
            if (index === undefined) return false;
            const b = { ...(blocks[index] as ToolBlock) };
            if (u.title) b.title = u.title;
            if (u.kind) b.toolKind = u.kind;
            if (u.status) b.status = u.status;
            if (u.content) b.content = u.content;
            if (u.rawInput !== undefined) b.rawInput = u.rawInput;
            if (u.rawOutput !== undefined) b.rawOutput = u.rawOutput;
            replace(index, b);
            return true;
          }
          case "plan":
          case "plan_update": {
            const entries = (u as { entries?: { content: string; status: string }[] }).entries ?? [];
            const l = last();
            if (l && l.kind === "plan") replace(blocks.length - 1, { kind: "plan", entries });
            else push({ kind: "plan", entries });
            return true;
          }
          default:
            return false;
        }
      }
      default:
        return false;
    }
  }

  return {
    get blocks() { return blocks; },
    get lastSeq() { return lastSeq; },
    apply(event) {
      if (event.seq >= 0) {
        if (event.seq <= lastSeq) return false;
        lastSeq = event.seq;
      }
      return reduceOne(event);
    },
  };
}

/** The blocks of one turn's events, oldest first. */
export function reduce(events: StoredEvent[]): Block[] {
  const reducer = createTurnReducer();
  for (const event of events) reducer.apply(event);
  return reducer.blocks;
}

/**
 * One turn of the transcript: a `user` event and everything the agent did in response. Turn
 * objects are immutable snapshots; the reducer behind them carries the state a live event needs.
 */
export type Turn = {
  /** The seq of the turn's first event (its `user` event, or the first on a page that starts inside a turn). */
  key: number;
  /** The highest logged seq the turn holds. */
  lastSeq: number;
  blocks: Block[];
  reducer: TurnReducer;
};

/**
 * The loaded part of the log, reduced turn by turn. Pages start at turn boundaries (or at a row
 * cap inside a long turn) and tool, plan, and permission updates only ever refer to their own
 * turn, so a live event updates only the last turn and an older page only adds turns in front.
 */
export type History = { turns: Turn[]; hasMore: boolean };

function snapshot(key: number, reducer: TurnReducer): Turn {
  return { key, lastSeq: reducer.lastSeq, blocks: reducer.blocks, reducer };
}

export function segment(events: StoredEvent[]): Turn[] {
  const turns: { key: number; reducer: TurnReducer }[] = [];
  for (const event of events) {
    const current = turns.at(-1);
    if (current && event.type !== "user") current.reducer.apply(event);
    else {
      const reducer = createTurnReducer();
      reducer.apply(event);
      turns.push({ key: event.seq, reducer });
    }
  }
  return turns.map(({ key, reducer }) => snapshot(key, reducer));
}

/**
 * The history with one more event. An event the history already holds (at or below the last
 * turn's `lastSeq`) leaves it unchanged, so a replayed or twice-applied event is harmless.
 */
export function appendEvent({ turns, hasMore }: History, event: StoredEvent): History {
  const current = turns.at(-1);
  if (!current || event.type === "user") {
    const reducer = createTurnReducer();
    reducer.apply(event);
    return { turns: [...turns, snapshot(event.seq, reducer)], hasMore };
  }
  if (event.seq >= 0 && event.seq <= current.lastSeq) return { turns, hasMore };
  current.reducer.apply(event);
  return { turns: [...turns.slice(0, -1), snapshot(current.key, current.reducer)], hasMore };
}

export const firstSeq = ({ turns }: History) => turns[0]?.key;
export const lastSeq = ({ turns }: History) => {
  const turn = turns.at(-1);
  return turn ? Math.max(turn.key, turn.lastSeq) : undefined;
};
