/**
 * Postgres-backed orchestrator store: one row per message and item, and one row each for
 * the snapshot and the memory text in `orchestrator_documents`. Every row keeps the
 * whole record in `body` (so reads round-trip exactly what was written) next to the columns the
 * queries filter and sort on. Changes are serialized per kind of record, as the file store did, so
 * a read-modify-write (patching an item) never interleaves with another of its kind.
 * Records are stripped of U+0000 before they are written (Postgres cannot store it, and a command's
 * output quoted in a message may carry it); the stripped record is what callers get back.
 */
import { and, asc, desc, eq, gt, inArray, lt, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { stripNul } from "../db/sanitize.ts";
import { orchestratorDocuments, orchestratorItems, orchestratorMessages } from "../db/schema.ts";
import { buildItem, capMemory, newId, parseItemPatch, patchItem, unknownItem } from "./store.ts";
import type { Item, ItemFilter, MessagePage, MessagePageQuery, OrchestratorMessage, OrchestratorStore, TickSnapshot } from "./types.ts";

type Body = Record<string, unknown>;
type Key = "messages" | "items" | "snapshot" | "memory";

const SNAPSHOT = "snapshot";
const MEMORY = "memory";

const itemColumns = (item: Item) => ({
  status: item.status, fingerprint: item.fingerprint,
  createdAt: item.createdAt, updatedAt: item.updatedAt, snoozedUntil: item.snoozedUntil, body: item as unknown as Body,
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

  const messageRows = (messages: OrchestratorMessage[]) =>
    stripNul(messages).map((message) => ({ id: message.id, body: message as unknown as Body }));

  return {
    ready: Promise.resolve(),

    async readMessages() {
      const rows = await db.select({ body: orchestratorMessages.body }).from(orchestratorMessages).orderBy(asc(orchestratorMessages.ordinal));
      return rows.map((row) => row.body as unknown as OrchestratorMessage);
    },
    async readMessageRows() {
      const rows = await db.select({ ordinal: orchestratorMessages.ordinal, body: orchestratorMessages.body }).from(orchestratorMessages)
        .orderBy(asc(orchestratorMessages.ordinal));
      return rows.map((row) => ({ ordinal: row.ordinal, message: row.body as unknown as OrchestratorMessage }));
    },
    async readMessagePage({ before, after, limit }: MessagePageQuery): Promise<MessagePage> {
      const where = and(
        ...(before === undefined ? [] : [lt(orchestratorMessages.ordinal, before)]),
        ...(after === undefined ? [] : [gt(orchestratorMessages.ordinal, after)]),
      );
      // Newest page (and pages before a cursor) read backwards; a page after a cursor reads forwards. One
      // extra row says whether more exist in the direction of travel.
      const forwards = after !== undefined && before === undefined;
      const rows = await db.select({ ordinal: orchestratorMessages.ordinal, body: orchestratorMessages.body }).from(orchestratorMessages)
        .where(where).orderBy(forwards ? asc(orchestratorMessages.ordinal) : desc(orchestratorMessages.ordinal)).limit(limit + 1);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      if (!forwards) page.reverse();
      return {
        messages: page.map((row) => row.body as unknown as OrchestratorMessage),
        hasMore,
        before: page[0]?.ordinal ?? null,
        after: page.at(-1)?.ordinal ?? null,
      };
    },
    async getMessage(id) {
      const [row] = await db.select({ body: orchestratorMessages.body }).from(orchestratorMessages)
        .where(eq(orchestratorMessages.id, id)).limit(1);
      return row ? (row.body as unknown as OrchestratorMessage) : null;
    },
    deleteMessagesThrough(ordinal) {
      return serialized("messages", async () => {
        await db.delete(orchestratorMessages).where(lte(orchestratorMessages.ordinal, ordinal));
      });
    },
    replaceMessage(ordinal, message) {
      return serialized("messages", async () => {
        const [row] = messageRows([message]);
        await db.update(orchestratorMessages).set({ id: row.id, body: row.body }).where(eq(orchestratorMessages.ordinal, ordinal));
      });
    },
    writeMessages(messages) {
      return serialized("messages", async () => {
        await db.transaction(async (tx) => {
          await tx.delete(orchestratorMessages);
          // One multi-row insert: Postgres numbers the rows in VALUES order, which is the chat's order.
          if (messages.length > 0) await tx.insert(orchestratorMessages).values(messageRows(messages));
        });
      });
    },
    appendMessages(messages) {
      return serialized("messages", async () => {
        if (messages.length === 0) return;
        await db.insert(orchestratorMessages).values(messageRows(messages));
      });
    },

    async listItems(filter?: ItemFilter) {
      const where = filter?.status ? inArray(orchestratorItems.status, filter.status) : sql`true`;
      const rows = await db.select({ body: orchestratorItems.body }).from(orchestratorItems).where(where).orderBy(...newestItems);
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
