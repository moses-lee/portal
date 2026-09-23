/**
 * Side threads: the agent (never the user) opens one per task so its back-and-forth stays out of
 * the main thread. A side thread carries a scope, which narrows memory retrieval in its turns, and
 * may belong to an intent.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DomainToolContext, ToolSet } from "../hub.ts";
import type { Thread } from "../types.ts";
import { define } from "./context.ts";
import { pullRefSchema } from "./items.ts";

const scopeSchema = z.object({
  projectIds: z.array(z.string()).optional(),
  sessionIds: z.array(z.string()).optional(),
  pulls: z.array(pullRefSchema).optional(),
  repos: z.array(z.string()).optional(),
  people: z.array(z.string()).optional(),
  taskTypes: z.array(z.string()).optional(),
});

function threadRow(thread: Thread) {
  return { id: thread.id, title: thread.title, status: thread.status, scope: thread.scope, intentId: thread.intentId };
}

/** Chat turns only (or a turn that names them): a tick has no business opening threads. */
export function threadTools(ctx: DomainToolContext): ToolSet {
  return ctx.interactive ? chatThreadTools(ctx) : {};
}

function chatThreadTools({ hub, turn }: DomainToolContext) {
  const { store } = hub;
  const emitThreads = async () => hub.emit({ type: "threads", threads: await store.listThreads() });
  return {
    open_thread: define(
      "Open a side thread for one task (a PR review, a long investigation) so its updates stay out of the main thread. scope names what it is about. message is the first note posted there. Tell the user in the main thread that you opened it.",
      z.object({ title: z.string().min(1).max(120), message: z.string().min(1).max(4000), scope: scopeSchema.optional(), intentId: z.string().optional() }),
      async ({ title, message, scope, intentId }) => {
        const thread = await store.createThread({ title, scope, intentId: intentId ?? null });
        await store.appendMessages([{
          id: randomUUID(), role: "assistant", parts: [{ type: "text", text: message }],
          metadata: { at: hub.timers.now(), run: { id: turn.runId, kind: turn.kind } },
        }], thread.id);
        void hub.activity.log({ actor: "agent", kind: "thread.created", summary: `Opened the thread "${title}"`, refs: { threadId: thread.id, runId: turn.runId } });
        await emitThreads();
        hub.emit({ type: "messages", threadId: thread.id });
        return threadRow(thread);
      },
    ),
    list_threads: define(
      "The threads: main first, then side threads by latest activity.",
      z.object({ status: z.enum(["active", "archived"]).optional() }),
      async ({ status = "active" }) => ({ threads: (await store.listThreads()).filter((thread) => thread.status === status).map(threadRow) }),
    ),
    post_to_thread: define(
      "Post a note to a side thread (a progress update, a finding) without a turn there.",
      z.object({ threadId: z.string().min(1), message: z.string().min(1).max(4000) }),
      async ({ threadId, message }) => {
        const thread = await store.getThread(threadId);
        if (!thread) throw new Error(`Unknown thread "${threadId}".`);
        await store.appendMessages([{
          id: randomUUID(), role: "assistant", parts: [{ type: "text", text: message }],
          metadata: { at: hub.timers.now(), run: { id: turn.runId, kind: turn.kind } },
        }], threadId);
        hub.emit({ type: "messages", threadId });
        return { posted: true, threadId };
      },
    ),
    archive_thread: define(
      "Archive a side thread whose task is finished.",
      z.object({ threadId: z.string().min(1) }),
      async ({ threadId }) => {
        const thread = await store.updateThread(threadId, { status: "archived" });
        await emitThreads();
        return threadRow(thread);
      },
    ),
  };
}
