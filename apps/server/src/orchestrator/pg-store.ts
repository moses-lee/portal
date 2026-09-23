/**
 * Postgres-backed orchestrator store: one row per message, thread, and item, and one row each for
 * the snapshot and the memory text in `orchestrator_documents`. Every row keeps the
 * whole record in `body` (so reads round-trip exactly what was written) next to the columns the
 * queries filter and sort on. Changes are serialized per kind of record, as the file store did, so
 * a read-modify-write (patching an item) never interleaves with another of its kind.
 * Records are stripped of U+0000 before they are written (Postgres cannot store it, and a command's
 * output quoted in a message may carry it); the stripped record is what callers get back.
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { stripNul } from "../db/sanitize.ts";
import { orchestratorDocuments, orchestratorItems, orchestratorMessages, threads } from "../db/schema.ts";
import {
  buildItem, buildThread, capMemory, mainThread, newId, parseItemPatch, patchItem, patchThread, sortThreads, unknownItem, unknownThread,
} from "./store.ts";
import type { Item, OrchestratorMessage, OrchestratorStore, Scope, Thread, TickSnapshot } from "./types.ts";
import { MAIN_THREAD_ID } from "./types.ts";

type Body = Record<string, unknown>;
type Key = "messages" | "items" | "snapshot" | "memory" | "threads";

const SNAPSHOT = "snapshot";
const MEMORY = "memory";

const itemColumns = (item: Item) => ({
  list: item.list, status: item.status, fingerprint: item.fingerprint,
  createdAt: item.createdAt, updatedAt: item.updatedAt, snoozedUntil: item.snoozedUntil, body: item as unknown as Body,
});

type ThreadRow = typeof threads.$inferSelect;

const threadFromRow = (row: ThreadRow): Thread => ({
  id: row.id, kind: row.kind as Thread["kind"], title: row.title, status: row.status as Thread["status"], scope: row.scope as unknown as Scope,
  intentId: row.intentId, createdAt: row.createdAt, updatedAt: row.updatedAt, lastMessageAt: row.lastMessageAt,
});

const threadColumns = (thread: Thread) => ({
  kind: thread.kind, title: thread.title, status: thread.status, scope: thread.scope as unknown as Body, intentId: thread.intentId,
  createdAt: thread.createdAt, updatedAt: thread.updatedAt, lastMessageAt: thread.lastMessageAt,
});

/** Items list newest first; `ordinal` breaks ties between records created in the same millisecond. */
const newestItems = [desc(orchestratorItems.createdAt), desc(orchestratorItems.ordinal)];

export function createPgOrchestratorStore({ db }: { db: Db }): OrchestratorStore {
  const queues = new Map<Key, Promise<unknown>>();

  /** Run `fn` after every earlier change of the same kind has settled (successfully or not). */
  function serialized<T>(key: Key, fn: () => Promise<T>): Promise<T> {
    const run = (queues.get(key) ?? Promise.resolve()).then(fn);
    const settled = run.catch(() => {}).then(() => {
      if (queues.get(key) === settled) queues.delete(key);
    });
    queues.set(key, settled);
    return run;
  }

  async function readItem(id: string): Promise<Item | null> {
    const [row] = await db.select({ body: orchestratorItems.body }).from(orchestratorItems).where(eq(orchestratorItems.id, id));
    return row ? (row.body as unknown as Item) : null;
  }

  async function readDocument(key: string): Promise<Body | null> {
    const [row] = await db.select({ body: orchestratorDocuments.body }).from(orchestratorDocuments).where(eq(orchestratorDocuments.key, key));
    return row?.body ?? null;
  }

  async function writeDocument(key: string, body: Body) {
    const updatedAt = Date.now();
    await db.insert(orchestratorDocuments).values({ key, body, updatedAt })
      .onConflictDoUpdate({ target: orchestratorDocuments.key, set: { body, updatedAt } });
  }

  const messageRows = (messages: OrchestratorMessage[], threadId: string) =>
    stripNul(messages).map((message) => ({ id: message.id, threadId, body: message as unknown as Body }));

  async function readThread(id: string): Promise<Thread | null> {
    const [row] = await db.select().from(threads).where(eq(threads.id, id));
    return row ? threadFromRow(row) : null;
  }

  async function requireThread(id: string): Promise<Thread> {
    const thread = await readThread(id);
    if (!thread) throw unknownThread(id);
    return thread;
  }

  // The migration seeds the main thread; this covers a database whose row was removed by hand.
  const main = mainThread();
  const ready = db.insert(threads).values({ id: main.id, ...threadColumns(main) }).onConflictDoNothing().then(() => {});

  return {
    ready,

    async readMessages(threadId = MAIN_THREAD_ID) {
      const rows = await db.select({ body: orchestratorMessages.body }).from(orchestratorMessages)
        .where(eq(orchestratorMessages.threadId, threadId)).orderBy(asc(orchestratorMessages.ordinal));
      return rows.map((row) => row.body as unknown as OrchestratorMessage);
    },
    writeMessages(messages, threadId = MAIN_THREAD_ID) {
      return serialized("messages", async () => {
        await requireThread(threadId);
        await db.transaction(async (tx) => {
          await tx.delete(orchestratorMessages).where(eq(orchestratorMessages.threadId, threadId));
          // One multi-row insert: Postgres numbers the rows in VALUES order, which is the thread order.
          if (messages.length > 0) await tx.insert(orchestratorMessages).values(messageRows(messages, threadId));
        });
      });
    },
    appendMessages(messages, threadId = MAIN_THREAD_ID) {
      return serialized("messages", async () => {
        await requireThread(threadId);
        if (messages.length === 0) return;
        await db.transaction(async (tx) => {
          await tx.insert(orchestratorMessages).values(messageRows(messages, threadId));
          await tx.update(threads).set({ lastMessageAt: Date.now() }).where(eq(threads.id, threadId));
        });
      });
    },

    async listThreads() {
      return sortThreads((await db.select().from(threads)).map(threadFromRow));
    },
    getThread: readThread,
    createThread(input) {
      return serialized("threads", async () => {
        let thread = buildThread(input, newId());
        while ((await db.insert(threads).values({ id: thread.id, ...threadColumns(stripNul(thread)) }).onConflictDoNothing().returning({ id: threads.id })).length === 0) {
          thread = { ...thread, id: newId() };
        }
        return thread;
      });
    },
    updateThread(id, patch) {
      return serialized("threads", async () => {
        const thread = stripNul(patchThread(await requireThread(id), patch));
        await db.update(threads).set(threadColumns(thread)).where(eq(threads.id, id));
        return thread;
      });
    },

    async listItems() {
      const rows = await db.select({ body: orchestratorItems.body }).from(orchestratorItems).orderBy(...newestItems);
      return rows.map((row) => row.body as unknown as Item);
    },
    getItem: readItem,
    async findItemByFingerprint(fingerprint) {
      const [row] = await db.select({ body: orchestratorItems.body }).from(orchestratorItems)
        .where(and(eq(orchestratorItems.fingerprint, fingerprint), inArray(orchestratorItems.status, ["open", "snoozed"])))
        .orderBy(...newestItems).limit(1);
      return row ? (row.body as unknown as Item) : null;
    },
    createItem(input) {
      return serialized("items", async () => {
        const at = Date.now();
        // Validated before the first insert, so a bad record fails without touching the table.
        let item = stripNul(buildItem(input, newId(), at));
        // An id collision (48 random bits) re-rolls instead of overwriting the other item.
        while ((await db.insert(orchestratorItems).values({ id: item.id, ...itemColumns(item) }).onConflictDoNothing().returning({ id: orchestratorItems.id })).length === 0) {
          item = { ...item, id: newId() };
        }
        return item;
      });
    },
    async updateItem(id, patch) {
      // Parsed before queueing so a bad patch fails fast and never waits behind a write.
      const allowed = parseItemPatch(patch);
      return serialized("items", async () => {
        const current = await readItem(id);
        if (!current) throw unknownItem(id);
        const item = stripNul(patchItem(current, allowed));
        await db.update(orchestratorItems).set(itemColumns(item)).where(eq(orchestratorItems.id, id));
        return item;
      });
    },

    async readSnapshot() {
      return (await readDocument(SNAPSHOT)) as TickSnapshot | null;
    },
    writeSnapshot(snapshot) {
      return serialized("snapshot", () => writeDocument(SNAPSHOT, stripNul(snapshot) as unknown as Body));
    },

    async readMemory() {
      const body = await readDocument(MEMORY);
      return typeof body?.text === "string" ? body.text : "";
    },
    writeMemory(text) {
      return serialized("memory", () => writeDocument(MEMORY, { text: capMemory(stripNul(text)) }));
    },
  };
}
