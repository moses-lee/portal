/**
 * Persistence for curated memory: entities, records, and revisions. Records are claims and never
 * change their words: a new body is a new record that supersedes the old one, and every write goes
 * through `commit`, one transaction of inserts and status updates that writes a revision per
 * change. Among active records `(entityId, key)` is unique; a change that would make a second one
 * fails with `MemoryConflictError`, naming the record that holds the key. The in-memory store here
 * backs tests and disposable runtimes; `pg-store.ts` is the live one, with the same behaviour.
 */
import type {
  EntityType, MemoryEntity, MemoryRecord, MemoryRevision, MemoryRevisionAction, RecordStatus, RecordType,
} from "@portal/contracts/memory";
import { entityTypes } from "@portal/contracts/memory";
import { OrchestratorStoreError, newId } from "../store.ts";

/** Who made a change and why, as its revision records it. */
export type RevisionMeta = { actor: MemoryRevision["actor"]; action: MemoryRevisionAction; reason?: string | null; runId?: string | null };

/** What an update may change. The claim itself (entity, key, body, scope, source) is fixed once written. */
export type RecordUpdate = Partial<Pick<MemoryRecord, "status" | "authority" | "trust" | "pinned" | "reviewBy" | "type" | "supersedes" | "supersededBy" | "sightings">>;

export type RecordChange =
  | { op: "insert"; record: MemoryRecord; revision: RevisionMeta }
  /** `from` guards against a stale read: the update fails with 409 unless the record is in one of these statuses. */
  | { op: "update"; id: string; from?: readonly RecordStatus[]; patch: RecordUpdate; revision: RevisionMeta };

export type RecordFilter = {
  status?: readonly RecordStatus[];
  entityIds?: readonly string[];
  type?: RecordType;
  pinned?: boolean;
  key?: string;
  /** Default 200, at most 1000. */
  limit?: number;
};

/** `all`: every term must match (the user's search box). `any`: rank by how many match (retrieval on a turn's text). */
export type SearchOptions = RecordFilter & { mode?: "all" | "any" };

export type SearchHit = { record: MemoryRecord; rank: number };

export type RevisionFilter = { recordId?: string; entityId?: string; action?: MemoryRevisionAction; before?: number; limit?: number };

export type RevisionInput = Omit<MemoryRevision, "id" | "at"> & { at?: number };

export interface MemoryStore {
  ready: Promise<void>;
  /** The entity for `(type, key)`, created (with `name`, else the key) when missing. */
  ensureEntity(input: { type: EntityType; key: string; name?: string }): Promise<MemoryEntity>;
  getEntity(id: string): Promise<MemoryEntity | null>;
  findEntity(type: EntityType, key: string): Promise<MemoryEntity | null>;
  /** Ordered by type (global first), then key; `activeRecords` counted. */
  listEntities(filter?: { type?: EntityType; ids?: readonly string[] }): Promise<MemoryEntity[]>;
  getRecord(id: string): Promise<MemoryRecord | null>;
  /** The active record holding `key` for the entity, if any. */
  activeRecord(entityId: string, key: string): Promise<MemoryRecord | null>;
  /** Newest change first. */
  listRecords(filter?: RecordFilter): Promise<MemoryRecord[]>;
  countRecords(filter?: Omit<RecordFilter, "limit">): Promise<number>;
  /** Full-text search over key and body, best match first. */
  searchRecords(query: string, options?: SearchOptions): Promise<SearchHit[]>;
  /** Apply the changes in order, all or nothing, with one revision each; resolves with the records as written. */
  commit(changes: RecordChange[]): Promise<MemoryRecord[]>;
  /** A revision that belongs to no single record change (the import marker, an entity note). */
  appendRevision(input: RevisionInput): Promise<MemoryRevision>;
  /** Replace an entity's summary and write a revision for it (no record), together; resolves with the entity as written. */
  setEntitySummary(entityId: string, summary: string, revision: RevisionMeta): Promise<MemoryEntity>;
  /** Newest first; page with `before=<id>`. */
  listRevisions(filter?: RevisionFilter): Promise<MemoryRevision[]>;
}

// ---------------------------------------------------------------------------------------------
// Shared rules
// ---------------------------------------------------------------------------------------------

export const DEFAULT_RECORD_LIMIT = 200;
export const MAX_RECORD_LIMIT = 1000;
export const DEFAULT_REVISION_LIMIT = 100;
export const MAX_REVISION_LIMIT = 500;

export function clamp(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(limit)));
}

/** A second active record for a key: the caller must supersede or edit `existing` instead. */
export class MemoryConflictError extends OrchestratorStoreError {
  existing: MemoryRecord;
  constructor(existing: MemoryRecord) {
    super(`Record ${existing.id} already holds the active claim for key "${existing.key}" on this entity ("${preview(existing.body)}"). Supersede or edit that record instead.`, 409);
    this.name = "MemoryConflictError";
    this.existing = existing;
  }
}

function preview(text: string, max = 80): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export const unknownRecord = (id: string) => new OrchestratorStoreError(`Unknown memory record "${id}".`, 404);

export const staleRecord = (record: MemoryRecord, from: readonly RecordStatus[]) =>
  new OrchestratorStoreError(`Record ${record.id} is ${record.status}, not ${from.join(" or ")}.`, 409);

export const newRecordId = () => `m${newId()}`;
export const newEntityId = () => `e${newId()}`;

const typeOrder = new Map(entityTypes.map((type, index) => [type, index]));

export function compareEntities(a: MemoryEntity, b: MemoryEntity): number {
  return (typeOrder.get(a.type) ?? 99) - (typeOrder.get(b.type) ?? 99) || a.key.localeCompare(b.key);
}

/** The record after an update, with `updatedAt` moved forward. */
export function applyUpdate(record: MemoryRecord, patch: RecordUpdate, now: number): MemoryRecord {
  const next: MemoryRecord = { ...record, updatedAt: Math.max(now, record.updatedAt + 1) };
  for (const key of ["status", "authority", "trust", "pinned", "reviewBy", "type", "supersedes", "supersededBy", "sightings"] as const) {
    if (patch[key] !== undefined) (next as Record<string, unknown>)[key] = patch[key];
  }
  return next;
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "do", "for", "from", "has", "have", "he", "her", "his", "i", "in", "is", "it", "its",
  "me", "my", "of", "on", "or", "our", "she", "so", "that", "the", "their", "them", "then", "there", "these", "they", "this", "to", "us",
  "was", "we", "were", "what", "when", "which", "who", "will", "with", "you", "your",
]);

/** Lowercase words of `text` without stopwords, for the in-memory search and for building an any-term query. */
export function searchTerms(text: string): string[] {
  const terms = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((term) => term.length > 1 && !STOPWORDS.has(term));
  return [...new Set(terms)];
}

function matchesFilter(record: MemoryRecord, filter: Omit<RecordFilter, "limit">): boolean {
  if (filter.status && !filter.status.includes(record.status)) return false;
  if (filter.entityIds && !filter.entityIds.includes(record.entityId)) return false;
  if (filter.type && record.type !== filter.type) return false;
  if (filter.pinned !== undefined && record.pinned !== filter.pinned) return false;
  if (filter.key !== undefined && record.key !== filter.key) return false;
  return true;
}

const newestFirst = (a: MemoryRecord, b: MemoryRecord) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt;

// ---------------------------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------------------------

export function createInMemoryMemoryStore({ now = Date.now }: { now?: () => number } = {}): MemoryStore {
  const entities = new Map<string, MemoryEntity>();
  let records = new Map<string, MemoryRecord>();
  const revisions: MemoryRevision[] = [];
  const copy = <T>(value: T): T => structuredClone(value);

  const withCount = (entity: MemoryEntity): MemoryEntity => ({
    ...entity, activeRecords: [...records.values()].filter((record) => record.entityId === entity.id && record.status === "active").length,
  });

  function activeIn(map: Map<string, MemoryRecord>, entityId: string, key: string, except?: string) {
    for (const record of map.values()) {
      if (record.entityId === entityId && record.key === key && record.status === "active" && record.id !== except) return record;
    }
    return null;
  }

  return {
    ready: Promise.resolve(),
    async ensureEntity({ type, key, name }) {
      for (const entity of entities.values()) if (entity.type === type && entity.key === key) return withCount(entity);
      const at = now();
      const entity: MemoryEntity = { id: newEntityId(), type, key, name: name?.trim() || key, summary: "", activeRecords: 0, createdAt: at, updatedAt: at };
      entities.set(entity.id, entity);
      return withCount(entity);
    },
    async getEntity(id) {
      const entity = entities.get(id);
      return entity ? withCount(entity) : null;
    },
    async findEntity(type, key) {
      for (const entity of entities.values()) if (entity.type === type && entity.key === key) return withCount(entity);
      return null;
    },
    async listEntities(filter = {}) {
      return [...entities.values()]
        .filter((entity) => (!filter.type || entity.type === filter.type) && (!filter.ids || filter.ids.includes(entity.id)))
        .map(withCount).sort(compareEntities);
    },
    async getRecord(id) {
      const record = records.get(id);
      return record ? copy(record) : null;
    },
    async activeRecord(entityId, key) {
      const record = activeIn(records, entityId, key);
      return record ? copy(record) : null;
    },
    async listRecords(filter = {}) {
      return [...records.values()].filter((record) => matchesFilter(record, filter)).sort(newestFirst)
        .slice(0, clamp(filter.limit, DEFAULT_RECORD_LIMIT, MAX_RECORD_LIMIT)).map(copy);
    },
    async countRecords(filter = {}) {
      return [...records.values()].filter((record) => matchesFilter(record, filter)).length;
    },
    async searchRecords(query, options = {}) {
      const terms = searchTerms(query);
      if (terms.length === 0) return [];
      const hits: SearchHit[] = [];
      for (const record of records.values()) {
        if (!matchesFilter(record, options)) continue;
        const words = searchTerms(`${record.key} ${record.body}`);
        const matched = terms.filter((term) => words.some((word) => word === term || word.startsWith(term))).length;
        if (matched === 0 || (options.mode !== "any" && matched < terms.length)) continue;
        hits.push({ record: copy(record), rank: matched / terms.length });
      }
      return hits.sort((a, b) => b.rank - a.rank || newestFirst(a.record, b.record)).slice(0, clamp(options.limit, DEFAULT_RECORD_LIMIT, MAX_RECORD_LIMIT));
    },
    async commit(changes) {
      // Work on a copy so a failing change leaves nothing behind.
      const working = new Map(records);
      const pending: Omit<MemoryRevision, "id">[] = [];
      const written: MemoryRecord[] = [];
      const at = now();
      for (const change of changes) {
        let before: MemoryRecord | null = null;
        let after: MemoryRecord;
        if (change.op === "insert") {
          if (working.has(change.record.id)) throw new OrchestratorStoreError(`Record ${change.record.id} already exists.`, 409);
          if (!entities.has(change.record.entityId)) throw new OrchestratorStoreError(`Unknown memory entity "${change.record.entityId}".`, 404);
          after = copy(change.record);
        } else {
          const current = working.get(change.id);
          if (!current) throw unknownRecord(change.id);
          if (change.from && !change.from.includes(current.status)) throw staleRecord(current, change.from);
          before = current;
          after = applyUpdate(current, change.patch, at);
        }
        if (after.status === "active") {
          const holder = activeIn(working, after.entityId, after.key, after.id);
          if (holder) throw new MemoryConflictError(copy(holder));
        }
        working.set(after.id, after);
        written.push(after);
        pending.push({
          recordId: after.id, entityId: after.entityId, at, actor: change.revision.actor, action: change.revision.action,
          before: before ? copy(before) : null, after: copy(after), reason: change.revision.reason ?? null, runId: change.revision.runId ?? null,
        });
      }
      records = working;
      for (const revision of pending) revisions.push({ ...revision, id: revisions.length + 1 });
      for (const record of written) {
        const entity = entities.get(record.entityId);
        if (entity) entity.updatedAt = Math.max(entity.updatedAt, at);
      }
      return written.map(copy);
    },
    async appendRevision(input) {
      const revision: MemoryRevision = { ...copy(input), at: input.at ?? now(), id: revisions.length + 1 };
      revisions.push(revision);
      return copy(revision);
    },
    async setEntitySummary(entityId, summary, revision) {
      const entity = entities.get(entityId);
      if (!entity) throw new OrchestratorStoreError(`Unknown memory entity "${entityId}".`, 404);
      const at = now();
      entity.summary = summary;
      entity.updatedAt = Math.max(at, entity.updatedAt);
      revisions.push({
        id: revisions.length + 1, recordId: null, entityId, at, actor: revision.actor, action: revision.action, before: null, after: null,
        reason: revision.reason ?? null, runId: revision.runId ?? null,
      });
      return withCount(entity);
    },
    async listRevisions(filter = {}) {
      const limit = clamp(filter.limit, DEFAULT_REVISION_LIMIT, MAX_REVISION_LIMIT);
      const found: MemoryRevision[] = [];
      for (let i = revisions.length - 1; i >= 0 && found.length < limit; i--) {
        const revision = revisions[i];
        if (filter.before !== undefined && revision.id >= filter.before) continue;
        if (filter.recordId && revision.recordId !== filter.recordId) continue;
        if (filter.entityId && revision.entityId !== filter.entityId) continue;
        if (filter.action && revision.action !== filter.action) continue;
        found.push(copy(revision));
      }
      return found;
    },
  };
}
