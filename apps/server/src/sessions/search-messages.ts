/**
 * What of a session's log global search reads (docs/SEARCH.md): user prompts and the agent's reply
 * text. Thoughts, tool calls and their output, and everything else are left out.
 *
 * One reply is one row. Adjacent reply chunks in the events given here join into one row covering
 * `firstSeq..seq` (the run's first and last event), with the first chunk's time. That covers old
 * and imported logs, which hold one event per chunk of a few characters. A run that continues an
 * earlier write (the runtime ends its text run at every flush, so a streamed reply reaches the
 * store as several appends) is joined to the stored row by `indexMessages` in the store.
 */
import type { StoredEvent } from "@portal/contracts/types";

/** The most characters of one prompt or reply that are indexed. */
export const MESSAGE_TEXT_MAX = 10_000;

export type MessageRow = { seq: number; firstSeq: number; role: "user" | "agent"; ts: number; text: string };

/** `earlier` then `later`, as one reply's text, within the cap. */
export function joinText(earlier: string, later: string): string {
  return earlier.length >= MESSAGE_TEXT_MAX ? earlier.slice(0, MESSAGE_TEXT_MAX) : (earlier + later).slice(0, MESSAGE_TEXT_MAX);
}

/** The reply text of an `agent_message_chunk` update, or null for any other event. */
export function replyText(event: StoredEvent): string | null {
  if (event.type !== "update") return null;
  const update = event.update as { sessionUpdate: string; content?: { type?: string; text?: unknown } };
  if (update.sessionUpdate !== "agent_message_chunk" || update.content?.type !== "text" || typeof update.content.text !== "string") return null;
  return update.content.text;
}

function row(firstSeq: number, seq: number, role: MessageRow["role"], ts: number, text: string): MessageRow | null {
  return text.trim() ? { seq, firstSeq, role, ts, text: text.slice(0, MESSAGE_TEXT_MAX) } : null;
}

/** The message rows of a run of events in seq order; blank text yields no row. */
export function messageRowsFrom(events: StoredEvent[]): MessageRow[] {
  const rows: MessageRow[] = [];
  type Run = { firstSeq: number; seq: number; ts: number; text: string };
  let run = null as Run | null;
  const close = (open: Run | null) => {
    const done = open && row(open.firstSeq, open.seq, "agent", open.ts, open.text);
    if (done) rows.push(done);
  };
  for (const event of events) {
    const reply = replyText(event);
    if (reply !== null) {
      // Joining stops growing at the cap; the run still takes the last chunk's seq.
      run = run ? { ...run, seq: event.seq, text: joinText(run.text, reply) } : { firstSeq: event.seq, seq: event.seq, ts: event.ts, text: reply };
      continue;
    }
    close(run);
    run = null;
    if (event.type === "user") {
      const prompt = row(event.seq, event.seq, "user", event.ts, event.text);
      if (prompt) rows.push(prompt);
    }
  }
  close(run);
  return rows;
}

/**
 * The events at the end of `events` that form an unfinished reply run: a caller reading the log in
 * pages holds them back and prepends them to the next page, so a run split by the page edge is
 * still one row.
 */
export function trailingReplyRun(events: StoredEvent[]): number {
  let i = events.length;
  while (i > 0 && replyText(events[i - 1]) !== null) i--;
  return events.length - i;
}
