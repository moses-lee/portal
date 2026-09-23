/**
 * Postgres-backed orchestrator store: one row per message, item, watch, and tick report, and one
 * row each for the snapshot and the memory text in `orchestrator_documents`. Every row keeps the
 * whole record in `body` (so reads round-trip exactly what was written) next to the columns the
 * queries filter and sort on. Changes are serialized per kind of record, as the file store did, so
 * a read-modify-write (patching an item, trimming ticks) never interleaves with another of its kind.
 */
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { orchestratorDocuments, orchestratorItems, orchestratorMessages, orchestratorTicks, orchestratorWatches } from "../db/schema.ts";
import {
  MAX_TICK_REPORTS, buildItem, buildWatch, capMemory, newId, parseItemPatch, parseWatchPatch, patchItem, patchWatch, unknownItem, unknownWatch,
} from "../lib/orchestrator/store.ts";
import type { Item, OrchestratorMessage, OrchestratorStore, TickReport, TickSnapshot, Watch } from "../lib/orchestrator/types.ts";

type Body = Record<string, unknown>;
type Key = "messages" | "items" | "watches" | "ticks" | "snapshot" | "memory";

const SNAPSHOT = "snapshot";
const MEMORY = "memory";

const itemColumns = (item: Item) => ({
  list: item.list, status: item.status, fingerprint: item.fingerprint,
  createdAt: item.createdAt, updatedAt: item.updatedAt, snoozedUntil: item.snoozedUntil, body: item as unknown as Body,
});

const watchColumns = (watch: Watch) => ({
  status: watch.status, createdAt: watch.createdAt, updatedAt: watch.updatedAt, lastCheckedAt: watch.lastCheckedAt, body: watch as unknown as Body,
});

/** Items and watches list newest first; `ordinal` breaks ties between records created in the same millisecond. */
const newestItems = [desc(orchestratorItems.createdAt), desc(orchestratorItems.ordinal)];
const newestWatches = [desc(orchestratorWatches.createdAt), desc(orchestratorWatches.ordinal)];

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

  async function readWatch(id: string): Promise<Watch | null> {
    const [row] = await db.select({ body: orchestratorWatches.body }).from(orchestratorWatches).where(eq(orchestratorWatches.id, id));
    return row ? (row.body as unknown as Watch) : null;
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

  const messageRows = (messages: OrchestratorMessage[]) => messages.map((message) => ({ id: message.id, body: message as unknown as Body }));

  return {
    ready: Promise.resolve(),

    async readMessages() {
      const rows = await db.select({ body: orchestratorMessages.body }).from(orchestratorMessages).orderBy(asc(orchestratorMessages.ordinal));
      return rows.map((row) => row.body as unknown as OrchestratorMessage);
    },
    writeMessages(messages) {
      return serialized("messages", () => db.transaction(async (tx) => {
        await tx.delete(orchestratorMessages);
        // One multi-row insert: Postgres numbers the rows in VALUES order, which is the thread order.
        if (messages.length > 0) await tx.insert(orchestratorMessages).values(messageRows(messages));
      }));
    },
    appendMessages(messages) {
      return serialized("messages", async () => {
        if (messages.length > 0) await db.insert(orchestratorMessages).values(messageRows(messages));
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
        let item = buildItem(input, newId(), at);
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
        const item = patchItem(current, allowed);
        await db.update(orchestratorItems).set(itemColumns(item)).where(eq(orchestratorItems.id, id));
        return item;
      });
    },

    async listWatches() {
      const rows = await db.select({ body: orchestratorWatches.body }).from(orchestratorWatches).orderBy(...newestWatches);
      return rows.map((row) => row.body as unknown as Watch);
    },
    getWatch: readWatch,
    createWatch(input) {
      return serialized("watches", async () => {
        const at = Date.now();
        let watch = buildWatch(input, newId(), at);
        while ((await db.insert(orchestratorWatches).values({ id: watch.id, ...watchColumns(watch) }).onConflictDoNothing().returning({ id: orchestratorWatches.id })).length === 0) {
          watch = { ...watch, id: newId() };
        }
        return watch;
      });
    },
    async updateWatch(id, patch) {
      const allowed = parseWatchPatch(patch);
      return serialized("watches", async () => {
        const current = await readWatch(id);
        if (!current) throw unknownWatch(id);
        const watch = patchWatch(current, allowed);
        await db.update(orchestratorWatches).set(watchColumns(watch)).where(eq(orchestratorWatches.id, id));
        return watch;
      });
    },

    async readSnapshot() {
      return (await readDocument(SNAPSHOT)) as TickSnapshot | null;
    },
    writeSnapshot(snapshot) {
      return serialized("snapshot", () => writeDocument(SNAPSHOT, snapshot as unknown as Body));
    },

    async listTicks() {
      const rows = await db.select({ body: orchestratorTicks.body }).from(orchestratorTicks).orderBy(asc(orchestratorTicks.ordinal));
      return rows.map((row) => row.body as unknown as TickReport);
    },
    appendTick(report) {
      return serialized("ticks", () => db.transaction(async (tx) => {
        await tx.insert(orchestratorTicks).values({ id: report.id, startedAt: report.startedAt, finishedAt: report.finishedAt, body: report as unknown as Body });
        // Keep the newest MAX_TICK_REPORTS: drop everything at or below the first ordinal past them.
        const cutoff = tx.select({ ordinal: orchestratorTicks.ordinal }).from(orchestratorTicks)
          .orderBy(desc(orchestratorTicks.ordinal)).offset(MAX_TICK_REPORTS).limit(1);
        await tx.delete(orchestratorTicks).where(lte(orchestratorTicks.ordinal, sql`(${cutoff})`));
      }));
    },

    async readMemory() {
      const body = await readDocument(MEMORY);
      return typeof body?.text === "string" ? body.text : "";
    },
    writeMemory(text) {
      return serialized("memory", () => writeDocument(MEMORY, { text: capMemory(text) }));
    },
  };
}
