/**
 * Curated memory in Postgres (`memory_entities`, `memory_records`, `memory_revisions`). A commit is
 * one transaction; the partial unique index on `(entity_id, key) where status = 'active'` backs the
 * conflict check, so even a race between two processes cannot leave two active claims for a key.
 * Search runs over the generated `search` tsvector. Values are stripped of U+0000 before writing.
 */
import { and, count, desc, eq, inArray, lt, sql, type SQL } from "drizzle-orm";
import type { EntityType, MemoryEntity, MemoryRecord, MemoryRevision } from "@portal/contracts/memory";
import type { Db } from "../../db/client.ts";
import { stripNul } from "../../db/sanitize.ts";
import { memoryEntities, memoryRecords, memoryRevisions } from "../../db/schema.ts";
import { OrchestratorStoreError } from "../store.ts";
import {
  DEFAULT_RECORD_LIMIT, DEFAULT_REVISION_LIMIT, MAX_RECORD_LIMIT, MAX_REVISION_LIMIT, MemoryConflictError, type MemoryStore, type RecordFilter,
  applyUpdate, clamp, compareEntities, newEntityId, searchTerms, staleRecord, unknownRecord,
} from "./store.ts";

type Json = Record<string, unknown>;
type RecordRow = typeof memoryRecords.$inferSelect;
type EntityRow = typeof memoryEntities.$inferSelect;
type RevisionRow = typeof memoryRevisions.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const recordFromRow = (row: RecordRow): MemoryRecord => ({
  id: row.id, entityId: row.entityId, type: row.type as MemoryRecord["type"], key: row.key, body: row.body, status: row.status as MemoryRecord["status"],
  scope: row.scope as unknown as MemoryRecord["scope"], authority: row.authority as MemoryRecord["authority"], source: row.source as MemoryRecord["source"],
  trust: row.trust, pinned: row.pinned, reviewBy: row.reviewBy, supersedes: row.supersedes, supersededBy: row.supersededBy,
  createdAt: row.createdAt, updatedAt: row.updatedAt,
});

const recordColumns = (record: MemoryRecord) => ({
  id: record.id, entityId: record.entityId, type: record.type, key: record.key, body: record.body, status: record.status,
  scope: record.scope as unknown as Json, authority: record.authority, source: record.source as unknown as Json, trust: record.trust,
  pinned: record.pinned, reviewBy: record.reviewBy, supersedes: record.supersedes, supersededBy: record.supersededBy,
  createdAt: record.createdAt, updatedAt: record.updatedAt,
});

const entityFromRow = (row: EntityRow, activeRecords: number): MemoryEntity => ({
  id: row.id, type: row.type as EntityType, key: row.key, name: row.name, summary: row.summary, activeRecords, createdAt: row.createdAt, updatedAt: row.updatedAt,
});

const revisionFromRow = (row: RevisionRow): MemoryRevision => ({
  id: row.id, recordId: row.recordId, entityId: row.entityId, at: row.at, actor: row.actor as MemoryRevision["actor"],
  action: row.action as MemoryRevision["action"], before: (row.before as unknown as MemoryRecord | null) ?? null,
  after: (row.after as unknown as MemoryRecord | null) ?? null, reason: row.reason, runId: row.runId,
});

/** A unique-index violation, however the driver wraps it. */
function isUniqueViolation(err: unknown): boolean {
  for (let current = err, depth = 0; current && typeof current === "object" && depth < 4; current = (current as { cause?: unknown }).cause, depth++) {
    if ((current as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

function recordWhere(filter: Omit<RecordFilter, "limit">): SQL | undefined {
  const where: SQL[] = [];
  if (filter.status) where.push(filter.status.length ? inArray(memoryRecords.status, [...filter.status]) : sql`false`);
  if (filter.entityIds) where.push(filter.entityIds.length ? inArray(memoryRecords.entityId, [...filter.entityIds]) : sql`false`);
  if (filter.type) where.push(eq(memoryRecords.type, filter.type));
  if (filter.pinned !== undefined) where.push(eq(memoryRecords.pinned, filter.pinned));
  if (filter.key !== undefined) where.push(eq(memoryRecords.key, filter.key));
  return where.length ? and(...where) : undefined;
}

// Spelled out: Drizzle leaves columns unqualified in a single-table select, which would bind "id" inside the subquery.
const activeCount = sql<number>`(select count(*)::int from memory_records r where r.entity_id = memory_entities.id and r.status = 'active')`;

export function createPgMemoryStore({ db, now = Date.now }: { db: Db; now?: () => number }): MemoryStore {
  async function selectEntities(where: SQL | undefined) {
    const rows = await db.select({ entity: memoryEntities, active: activeCount }).from(memoryEntities).where(where);
    return rows.map((row) => entityFromRow(row.entity, Number(row.active))).sort(compareEntities);
  }

  async function activeIn(tx: Tx | Db, entityId: string, key: string, except: string) {
    const [row] = await tx.select().from(memoryRecords)
      .where(and(eq(memoryRecords.entityId, entityId), eq(memoryRecords.key, key), eq(memoryRecords.status, "active"), sql`${memoryRecords.id} <> ${except}`));
    return row ? recordFromRow(row) : null;
  }

  const store: MemoryStore = {
    ready: Promise.resolve(),
    async ensureEntity({ type, key, name }) {
      const at = now();
      await db.insert(memoryEntities)
        .values(stripNul({ id: newEntityId(), type, key, name: name?.trim() || key, summary: "", createdAt: at, updatedAt: at }))
        .onConflictDoNothing({ target: [memoryEntities.type, memoryEntities.key] });
      const [entity] = await selectEntities(and(eq(memoryEntities.type, type), eq(memoryEntities.key, stripNul(key))));
      return entity;
    },
    async getEntity(id) {
      return (await selectEntities(eq(memoryEntities.id, id)))[0] ?? null;
    },
    async findEntity(type, key) {
      return (await selectEntities(and(eq(memoryEntities.type, type), eq(memoryEntities.key, key))))[0] ?? null;
    },
    async listEntities(filter = {}) {
      const where: SQL[] = [];
      if (filter.type) where.push(eq(memoryEntities.type, filter.type));
      if (filter.ids) where.push(filter.ids.length ? inArray(memoryEntities.id, [...filter.ids]) : sql`false`);
      return selectEntities(where.length ? and(...where) : undefined);
    },
    async getRecord(id) {
      const [row] = await db.select().from(memoryRecords).where(eq(memoryRecords.id, id));
      return row ? recordFromRow(row) : null;
    },
    async activeRecord(entityId, key) {
      return activeIn(db, entityId, key, "");
    },
    async listRecords(filter = {}) {
      const rows = await db.select().from(memoryRecords).where(recordWhere(filter))
        .orderBy(desc(memoryRecords.updatedAt), desc(memoryRecords.createdAt)).limit(clamp(filter.limit, DEFAULT_RECORD_LIMIT, MAX_RECORD_LIMIT));
      return rows.map(recordFromRow);
    },
    async countRecords(filter = {}) {
      const [row] = await db.select({ n: count() }).from(memoryRecords).where(recordWhere(filter));
      return Number(row?.n ?? 0);
    },
    async searchRecords(query, options = {}) {
      const text = stripNul(query);
      let tsquery: SQL;
      if (options.mode === "any") {
        // Plain words joined by "or": nothing the user typed can reach the query syntax.
        const terms = searchTerms(text);
        if (terms.length === 0) return [];
        tsquery = sql`websearch_to_tsquery('english', ${terms.join(" or ")})`;
      } else {
        if (!text.trim()) return [];
        tsquery = sql`websearch_to_tsquery('english', ${text})`;
      }
      const rank = sql<number>`ts_rank(${memoryRecords.search}, ${tsquery})`;
      const filter = recordWhere(options);
      const rows = await db.select({ record: memoryRecords, rank }).from(memoryRecords)
        .where(and(sql`${memoryRecords.search} @@ ${tsquery}`, ...(filter ? [filter] : [])))
        .orderBy(desc(rank), desc(memoryRecords.updatedAt)).limit(clamp(options.limit, DEFAULT_RECORD_LIMIT, MAX_RECORD_LIMIT));
      return rows.map((row) => ({ record: recordFromRow(row.record), rank: Number(row.rank) }));
    },
    async commit(changes) {
      const at = now();
      try {
        return await db.transaction(async (tx) => {
          const written: MemoryRecord[] = [];
          for (const change of changes) {
            let before: MemoryRecord | null = null;
            let after: MemoryRecord;
            if (change.op === "insert") {
              after = stripNul(change.record);
            } else {
              const [row] = await tx.select().from(memoryRecords).where(eq(memoryRecords.id, change.id)).for("update");
              if (!row) throw unknownRecord(change.id);
              before = recordFromRow(row);
              if (change.from && !change.from.includes(before.status)) throw staleRecord(before, change.from);
              after = applyUpdate(before, change.patch, at);
            }
            if (after.status === "active") {
              const holder = await activeIn(tx, after.entityId, after.key, after.id);
              if (holder) throw new MemoryConflictError(holder);
            }
            if (change.op === "insert") {
              const [entity] = await tx.select({ id: memoryEntities.id }).from(memoryEntities).where(eq(memoryEntities.id, after.entityId));
              if (!entity) throw new OrchestratorStoreError(`Unknown memory entity "${after.entityId}".`, 404);
              await tx.insert(memoryRecords).values(recordColumns(after));
            } else {
              const { id: _id, ...columns } = recordColumns(after);
              await tx.update(memoryRecords).set(columns).where(eq(memoryRecords.id, after.id));
            }
            await tx.insert(memoryRevisions).values(stripNul({
              recordId: after.id, entityId: after.entityId, at, actor: change.revision.actor, action: change.revision.action,
              before: before as unknown as Json | null, after: after as unknown as Json, reason: change.revision.reason ?? null, runId: change.revision.runId ?? null,
            }));
            await tx.update(memoryEntities).set({ updatedAt: sql`greatest(${memoryEntities.updatedAt}, ${at})` }).where(eq(memoryEntities.id, after.entityId));
            written.push(after);
          }
          return written;
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Another writer took the key between the check and the write: name whoever holds it now.
        for (const change of changes) {
          const record = change.op === "insert" ? change.record : await store.getRecord(change.id);
          const holder = record ? await activeIn(db, record.entityId, record.key, record.id) : null;
          if (holder) throw new MemoryConflictError(holder);
        }
        throw new OrchestratorStoreError("Another change to this memory key landed first; try again.", 409);
      }
    },
    async appendRevision(input) {
      const [row] = await db.insert(memoryRevisions).values(stripNul({
        recordId: input.recordId, entityId: input.entityId, at: input.at ?? now(), actor: input.actor, action: input.action,
        before: input.before as unknown as Json | null, after: input.after as unknown as Json | null, reason: input.reason, runId: input.runId,
      })).returning();
      return revisionFromRow(row);
    },
    async listRevisions(filter = {}) {
      const where: SQL[] = [];
      if (filter.before !== undefined) where.push(lt(memoryRevisions.id, filter.before));
      if (filter.recordId) where.push(eq(memoryRevisions.recordId, filter.recordId));
      if (filter.entityId) where.push(eq(memoryRevisions.entityId, filter.entityId));
      if (filter.action) where.push(eq(memoryRevisions.action, filter.action));
      const rows = await db.select().from(memoryRevisions).where(where.length ? and(...where) : undefined)
        .orderBy(desc(memoryRevisions.id)).limit(clamp(filter.limit, DEFAULT_REVISION_LIMIT, MAX_REVISION_LIMIT));
      return rows.map(revisionFromRow);
    },
  };
  return store;
}
