/**
 * Curated memory: the one place that changes records. Claims the user states apply at once
 * (`remember`, a record created or edited in the browser); claims the agent observes or infers go
 * to the inbox (`propose`) and become active only on `approve`. A new claim for a key that already
 * has an active one supersedes it in the same transaction; nothing is overwritten or deleted, every
 * change writes a revision, an activity entry, and a `memory` event. `promptContext` gives each turn
 * CORE.md (cached until memory changes) and the records retrieved for its scope and text.
 */
import type {
  Authority, CoreDocument, MemoryEntity, MemoryRecord, MemoryRecordInput, MemoryRecordPatch, MemoryRevision, RecordSource, RecordStatus, RecordType,
} from "@portal/contracts/memory";
import { recordTypes } from "@portal/contracts/memory";
import type { MemoryPromptContext, MemoryService, OrchestratorHub, ToolSet, DomainToolContext } from "../hub.ts";
import { OrchestratorStoreError } from "../store.ts";
import { orchestratorProviders, type Scope } from "../types.ts";
import { buildCore, entityLabel, rankRetrieved, renderRetrieved } from "./core.ts";
import { splitLegacyMemory } from "./import.ts";
import { createPgMemoryStore } from "./pg-store.ts";
import { type MemoryStore, type RecordChange, type SearchHit, createInMemoryMemoryStore, newRecordId } from "./store.ts";
import { memoryTools } from "./tools.ts";
import { type ValidatedRecord, canPin, defaultTrust, normalizeEntityKey, validateRecord } from "./validate.ts";

export type MemoryOptions = {
  /** Where records live; Postgres when the hub has a database, else in memory. */
  store?: MemoryStore;
  /** Skip the one-time import of the legacy memory text (tests that seed it themselves). */
  importLegacy?: boolean;
};

/** Who is acting, for revisions and the activity log. */
export type Actor = { actor: "user" | "agent" | "system"; runId?: string | null; threadId?: string | null };

export type ChangeResult = {
  record: MemoryRecord;
  /** The record this change replaced. */
  superseded?: MemoryRecord | null;
  /** True when the same claim was already there and nothing was written. */
  unchanged?: boolean;
};

export type Explanation = {
  record: MemoryRecord;
  entity: MemoryEntity | null;
  revisions: MemoryRevision[];
  /** Older claims this one replaced, newest first, and the claim that replaced it, if any. */
  lineage: { earlier: MemoryRecord[]; replacedBy: MemoryRecord | null };
};

export type ImportResult = { imported: number; skipped: number; alreadyDone: boolean };

export interface CuratedMemoryService extends MemoryService {
  store: MemoryStore;
  remember(input: MemoryRecordInput, who: Actor): Promise<ChangeResult>;
  /** A record the user adds in the browser: user-stated, but a key that is taken is a 409 rather than a silent supersede. */
  create(input: MemoryRecordInput, who: Actor): Promise<ChangeResult>;
  propose(input: MemoryRecordInput & { authority: Authority }, who: Actor): Promise<ChangeResult>;
  approve(id: string, who: Actor): Promise<ChangeResult>;
  reject(id: string, reason: string | null, who: Actor): Promise<MemoryRecord>;
  forget(id: string, reason: string | null, who: Actor): Promise<MemoryRecord>;
  edit(id: string, patch: MemoryRecordPatch, who: Actor): Promise<ChangeResult>;
  explain(id: string): Promise<Explanation>;
  search(query: string, options?: { entityIds?: string[]; status?: RecordStatus[]; type?: RecordType; limit?: number }): Promise<SearchHit[]>;
  core(): Promise<CoreDocument>;
  /** The entity for a type and a key as the user or the model wrote it (normalized), or null. */
  findEntity(type: MemoryEntity["type"], key: string): Promise<MemoryEntity | null>;
  importLegacy(): Promise<ImportResult>;
}

/** Same claim, ignoring case and spacing. */
const sameClaim = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

const short = (text: string, max = 100) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

export function createMemoryService(hub: OrchestratorHub, options: MemoryOptions = {}): CuratedMemoryService {
  const now = () => hub.timers.now();
  const store = options.store ?? (hub.db ? createPgMemoryStore({ db: hub.db, now }) : createInMemoryMemoryStore({ now }));
  let coreCache: CoreDocument | null = null;

  async function knownSecrets(): Promise<string[]> {
    const keys = await Promise.all(orchestratorProviders.map((provider) => hub.settings.apiKey(provider).catch(() => null)));
    return keys.filter((key): key is string => typeof key === "string" && key.length > 0);
  }

  async function validate(input: MemoryRecordInput & { authority: Authority }) {
    return validateRecord(input, { knownSecrets: await knownSecrets() });
  }

  function build(valid: ValidatedRecord, entity: MemoryEntity, status: RecordStatus, extra: Partial<MemoryRecord> = {}): MemoryRecord {
    const at = now();
    return {
      id: newRecordId(), entityId: entity.id, type: valid.type, key: valid.key, body: valid.body, status, scope: valid.scope,
      authority: valid.authority, source: valid.source, trust: valid.trust, pinned: valid.pinned, reviewBy: valid.reviewBy,
      supersedes: null, supersededBy: null, createdAt: at, updatedAt: at, ...extra,
    };
  }

  /** After every change: drop the cached CORE.md, tell the page, and log what happened. */
  async function changed(records: MemoryRecord[], who: Actor, entries: { kind: string; summary: string; record: MemoryRecord; detail?: Record<string, unknown> }[]) {
    coreCache = null;
    hub.emit({ type: "memory", recordIds: [...new Set(records.map((record) => record.id))] });
    for (const entry of entries) {
      await hub.activity.log({
        actor: who.actor, kind: entry.kind, summary: entry.summary,
        refs: { recordId: entry.record.id, entityId: entry.record.entityId, ...(who.runId ? { runId: who.runId } : {}), ...(who.threadId ? { threadId: who.threadId } : {}) },
        detail: { key: entry.record.key, status: entry.record.status, authority: entry.record.authority, ...entry.detail },
      });
    }
  }

  async function label(entityId: string) {
    const entity = await store.getEntity(entityId);
    return entity ? entityLabel(entity) : entityId;
  }

  async function requireRecord(id: string) {
    const record = await store.getRecord(id);
    if (!record) throw new OrchestratorStoreError(`Unknown memory record "${id}".`, 404);
    return record;
  }

  const meta = (who: Actor, action: MemoryRevision["action"], reason?: string | null) => ({ actor: who.actor, action, reason: reason ?? null, runId: who.runId ?? null });

  /** A user-stated claim, active at once; `onConflict` decides what happens to an active record for the key. */
  async function state(input: MemoryRecordInput, who: Actor, onConflict: "supersede" | "reject"): Promise<ChangeResult> {
    const defaultSource: RecordSource = who.actor === "user" ? { kind: "ui" } : { kind: "message" };
    const valid = await validate({ ...input, authority: "user_stated", source: input.source ?? defaultSource });
    const entity = await store.ensureEntity(valid.entity);
    const active = await store.activeRecord(entity.id, valid.key);
    if (active && sameClaim(active.body, valid.body) && active.type === valid.type && active.pinned === valid.pinned) return { record: active, unchanged: true };
    const where = entityLabel(entity);
    if (!active) {
      const [record] = await store.commit([{ op: "insert", record: build(valid, entity, "active"), revision: meta(who, "created") }]);
      await changed([record], who, [{ kind: "memory.remembered", summary: `Remembered for ${where}: ${short(record.body)}`, record }]);
      return { record };
    }
    if (onConflict === "reject") {
      // Let the store name the holder, exactly as a racing writer would see it.
      await store.commit([{ op: "insert", record: build(valid, entity, "active"), revision: meta(who, "created") }]);
    }
    const next = build(valid, entity, "active", { supersedes: active.id });
    const [old, record] = await store.commit([
      { op: "update", id: active.id, from: ["active"], patch: { status: "superseded", supersededBy: next.id }, revision: meta(who, "superseded", `Replaced by ${next.id}`) },
      { op: "insert", record: next, revision: meta(who, "created") },
    ]);
    await changed([old, record], who, [
      { kind: "memory.remembered", summary: `Remembered for ${where}: ${short(record.body)}`, record },
      { kind: "memory.superseded", summary: `Replaced "${short(old.body, 60)}" (${where} · ${old.key})`, record: old, detail: { supersededBy: record.id } },
    ]);
    return { record, superseded: old };
  }

  async function propose(input: MemoryRecordInput & { authority: Authority }, who: Actor): Promise<ChangeResult> {
    if (input.authority !== "observed" && input.authority !== "inferred") {
      throw new OrchestratorStoreError("A proposal is observed or inferred; what the user states is remembered instead.", 400);
    }
    const valid = await validate({ ...input, pinned: false });
    const entity = await store.ensureEntity(valid.entity);
    const active = await store.activeRecord(entity.id, valid.key);
    if (active && sameClaim(active.body, valid.body)) return { record: active, unchanged: true };
    const waiting = (await store.listRecords({ status: ["proposed"], entityIds: [entity.id], key: valid.key })).find((record) => sameClaim(record.body, valid.body));
    if (waiting) return { record: waiting, unchanged: true };
    const [record] = await store.commit([
      { op: "insert", record: build(valid, entity, "proposed", { supersedes: active?.id ?? null }), revision: meta(who, "created") },
    ]);
    const where = entityLabel(entity);
    await changed([record], who, [{
      kind: "memory.proposed", summary: `Proposed for ${where}: ${short(record.body)}${active ? ` (would replace ${active.id})` : ""}`, record,
    }]);
    return { record };
  }

  async function approve(id: string, who: Actor): Promise<ChangeResult> {
    const record = await requireRecord(id);
    if (record.status !== "proposed") throw new OrchestratorStoreError(`Record ${id} is ${record.status}; only a proposed record can be approved.`, 409);
    const active = await store.activeRecord(record.entityId, record.key);
    const changes: RecordChange[] = [];
    if (active) {
      changes.push({ op: "update", id: active.id, from: ["active"], patch: { status: "superseded", supersededBy: record.id }, revision: meta(who, "superseded", `Replaced by ${record.id}`) });
    }
    changes.push({
      op: "update", id, from: ["proposed"],
      patch: { status: "active", authority: "user_confirmed", trust: defaultTrust.user_confirmed, ...(active ? { supersedes: active.id } : {}) },
      revision: meta(who, "approved"),
    });
    const written = await store.commit(changes);
    const approved = written.at(-1)!;
    const old = active ? written[0] : null;
    const where = await label(record.entityId);
    await changed(written, who, [
      { kind: "memory.approved", summary: `Approved for ${where}: ${short(approved.body)}`, record: approved },
      ...(old ? [{ kind: "memory.superseded", summary: `Replaced "${short(old.body, 60)}" (${where} · ${old.key})`, record: old, detail: { supersededBy: approved.id } }] : []),
    ]);
    return { record: approved, superseded: old };
  }

  async function reject(id: string, reason: string | null, who: Actor) {
    const record = await requireRecord(id);
    if (record.status !== "proposed") throw new OrchestratorStoreError(`Record ${id} is ${record.status}; only a proposed record can be rejected.`, 409);
    const [rejected] = await store.commit([{ op: "update", id, from: ["proposed"], patch: { status: "rejected" }, revision: meta(who, "rejected", reason) }]);
    await changed([rejected], who, [{ kind: "memory.rejected", summary: `Rejected for ${await label(record.entityId)}: ${short(record.body)}`, record: rejected, detail: { reason } }]);
    return rejected;
  }

  async function forget(id: string, reason: string | null, who: Actor) {
    const record = await requireRecord(id);
    if (record.status !== "active" && record.status !== "proposed") {
      throw new OrchestratorStoreError(`Record ${id} is ${record.status}; only an active or proposed record can be forgotten.`, 409);
    }
    const [archived] = await store.commit([{ op: "update", id, from: ["active", "proposed"], patch: { status: "archived" }, revision: meta(who, "forgotten", reason) }]);
    await changed([archived], who, [{ kind: "memory.forgotten", summary: `Forgot for ${await label(record.entityId)}: ${short(record.body)}`, record: archived, detail: { reason } }]);
    return archived;
  }

  async function edit(id: string, patch: MemoryRecordPatch, who: Actor): Promise<ChangeResult> {
    const record = await requireRecord(id);
    if (patch.status === "archived") return { record: await forget(id, "Archived in the memory browser", who) };
    if (record.status !== "active" && record.status !== "proposed") throw new OrchestratorStoreError(`Record ${id} is ${record.status}; it can no longer be edited.`, 409);
    if (patch.type !== undefined && !recordTypes.includes(patch.type)) throw new OrchestratorStoreError(`Unknown record type "${String(patch.type)}".`, 400);
    const where = await label(record.entityId);
    const newBody = patch.body !== undefined && !sameClaim(patch.body, record.body);

    if (newBody) {
      // A new claim in the user's words: user-stated, active, replacing the record edited and whatever held its key.
      const entity = await store.getEntity(record.entityId);
      if (!entity) throw new OrchestratorStoreError(`Unknown memory entity "${record.entityId}".`, 404);
      const valid = await validate({
        entity: { type: entity.type, key: entity.key }, type: patch.type ?? record.type, key: record.key, body: patch.body ?? record.body, scope: record.scope,
        pinned: patch.pinned ?? record.pinned, reviewBy: patch.reviewBy !== undefined ? patch.reviewBy : record.reviewBy,
        authority: "user_stated", source: { kind: "ui", quote: patch.body?.trim().slice(0, 500) },
      });
      const active = record.status === "active" ? record : await store.activeRecord(record.entityId, record.key);
      const next = build(valid, entity, "active", { supersedes: active?.id ?? record.id });
      const changes: RecordChange[] = [];
      if (record.status === "proposed") {
        changes.push({ op: "update", id: record.id, from: ["proposed"], patch: { status: "superseded", supersededBy: next.id }, revision: meta(who, "superseded", `Edited into ${next.id}`) });
      }
      if (active) {
        changes.push({ op: "update", id: active.id, from: ["active"], patch: { status: "superseded", supersededBy: next.id }, revision: meta(who, "superseded", `Edited into ${next.id}`) });
      }
      changes.push({ op: "insert", record: next, revision: meta(who, "updated", `Edit of ${record.id}`) });
      const written = await store.commit(changes);
      const created = written.at(-1)!;
      await changed(written, who, [
        { kind: "memory.remembered", summary: `Edited for ${where}: ${short(created.body)}`, record: created, detail: { edited: record.id } },
        ...written.slice(0, -1).map((old) => ({ kind: "memory.superseded", summary: `Replaced "${short(old.body, 60)}" (${where} · ${old.key})`, record: old, detail: { supersededBy: created.id } })),
      ]);
      return { record: created, superseded: active ?? record };
    }

    const update: Partial<MemoryRecord> = {};
    if (patch.pinned !== undefined && patch.pinned !== record.pinned) {
      if (patch.pinned && (record.status !== "active" || !canPin(record.authority, record.source))) {
        throw new OrchestratorStoreError("Only active claims the user stated or confirmed, from their own words, can be pinned.", 400);
      }
      update.pinned = patch.pinned;
    }
    if (patch.reviewBy !== undefined && patch.reviewBy !== record.reviewBy) {
      if (patch.reviewBy !== null && !Number.isSafeInteger(patch.reviewBy)) throw new OrchestratorStoreError("reviewBy must be epoch milliseconds or null.", 400);
      update.reviewBy = patch.reviewBy;
    }
    if (patch.type !== undefined && patch.type !== record.type) update.type = patch.type;
    if (Object.keys(update).length === 0) return { record, unchanged: true };
    const [updated] = await store.commit([{ op: "update", id, from: [record.status], patch: update, revision: meta(who, "updated") }]);
    await changed([updated], who, [{ kind: "memory.updated", summary: `Updated ${where} · ${updated.key} (${Object.keys(update).join(", ")})`, record: updated, detail: { changed: update } }]);
    return { record: updated };
  }

  async function explain(id: string): Promise<Explanation> {
    const record = await requireRecord(id);
    const [entity, revisions] = await Promise.all([store.getEntity(record.entityId), store.listRevisions({ recordId: id, limit: 50 })]);
    const earlier: MemoryRecord[] = [];
    for (let at = record.supersedes; at && earlier.length < 10;) {
      const older = await store.getRecord(at);
      if (!older) break;
      earlier.push(older);
      at = older.supersedes;
    }
    const replacedBy = record.supersededBy ? await store.getRecord(record.supersededBy) : null;
    return { record, entity, revisions, lineage: { earlier, replacedBy } };
  }

  async function core(): Promise<CoreDocument> {
    if (coreCache) return coreCache;
    const [entities, active] = await Promise.all([store.listEntities(), store.listRecords({ status: ["active"], limit: 1000 })]);
    coreCache = buildCore({ entities, active, now: now() });
    return coreCache;
  }

  /** The entities a turn is about: its scope's, the global one, and any whose key the turn's text names. */
  function scopedEntities(entities: MemoryEntity[], scope: Scope, query: string): string[] {
    const wanted = new Set<string>(["global:global"]);
    const lower = (value: string) => value.trim().toLowerCase();
    for (const repo of [...scope.repos, ...scope.pulls.map((pull) => pull.repo)]) wanted.add(`repo:${lower(repo)}`);
    for (const login of scope.people) wanted.add(`person:${lower(login).replace(/^@/, "")}`);
    for (const slug of scope.taskTypes) wanted.add(`task_type:${lower(slug)}`);
    for (const id of scope.projectIds) wanted.add(`project:${id}`);
    for (const id of scope.sessionIds) wanted.add(`session:${id}`);
    const text = query.toLowerCase();
    const named = (key: string) => {
      const at = text.indexOf(key.toLowerCase());
      if (at < 0) return false;
      const before = text[at - 1] ?? " ";
      const after = text[at + key.length] ?? " ";
      return !/[a-z0-9_/-]/.test(before) && !/[a-z0-9_/-]/.test(after);
    };
    return entities.filter((entity) => wanted.has(`${entity.type}:${entity.key}`) || (entity.type !== "global" && entity.key.length > 2 && named(entity.key)))
      .map((entity) => entity.id);
  }

  async function promptContext({ scope, query }: { scope: Scope; query: string; threadId: string | null }): Promise<MemoryPromptContext> {
    const coreDoc = await core();
    const entities = await store.listEntities();
    const byId = new Map(entities.map((entity) => [entity.id, entity]));
    const ids = scopedEntities(entities, scope, query);
    const [scoped, hits] = await Promise.all([
      ids.length ? store.listRecords({ status: ["active"], entityIds: ids, limit: 200 }) : Promise.resolve([]),
      query.trim() ? store.searchRecords(query, { mode: "any", status: ["active"], limit: 30 }) : Promise.resolve([]),
    ]);
    return { core: coreDoc, retrieved: renderRetrieved(rankRetrieved({ scoped, hits, entities: byId }), byId) };
  }

  async function importLegacy(): Promise<ImportResult> {
    if ((await store.listRevisions({ action: "imported", limit: 1 })).length > 0) return { imported: 0, skipped: 0, alreadyDone: true };
    const text = await hub.store.readMemory();
    if (!text.trim()) return { imported: 0, skipped: 0, alreadyDone: false };
    const global = await store.ensureEntity({ type: "global", key: "global", name: "Global" });
    const taken = (await store.listRecords({ entityIds: [global.id], limit: 1000 })).map((record) => record.key);
    const secrets = await knownSecrets();
    const system: Actor = { actor: "system" };
    const records: MemoryRecord[] = [];
    let skipped = 0;
    for (const claim of splitLegacyMemory(text, taken)) {
      try {
        const valid = validateRecord({
          entity: { type: "global", key: "global" }, type: claim.type, key: claim.key, body: claim.body, authority: "observed",
          source: { kind: "import", quote: claim.quote },
        }, { knownSecrets: secrets });
        records.push(build(valid, global, "proposed"));
      } catch {
        // A line the validator refuses (a secret, an oversized block) stays only in the legacy text.
        skipped++;
      }
    }
    const written = records.length ? await store.commit(records.map((record) => ({ op: "insert" as const, record, revision: meta(system, "imported", "Legacy memory text") }))) : [];
    // The marker: with it, the import never runs again, even when every line was skipped.
    await store.appendRevision({
      recordId: null, entityId: global.id, actor: "system", action: "imported", before: null, after: null,
      reason: `Legacy memory text: ${written.length} claims proposed, ${skipped} skipped`, runId: null,
    });
    coreCache = null;
    if (written.length) hub.emit({ type: "memory", recordIds: written.map((record) => record.id) });
    await hub.activity.log({
      actor: "system", kind: "memory.imported", summary: `Imported ${written.length} claims from the old memory notes into the inbox${skipped ? ` (${skipped} skipped)` : ""}`,
      refs: { entityId: global.id }, detail: { imported: written.length, skipped },
    });
    return { imported: written.length, skipped, alreadyDone: false };
  }

  const service: CuratedMemoryService = {
    store,
    ready: Promise.resolve(),
    promptContext,
    inboxCount: () => store.countRecords({ status: ["proposed"] }),
    async recordsFor(wanted) {
      const found: { entity: MemoryEntity; records: MemoryRecord[] }[] = [];
      for (const { type, key } of wanted) {
        const entity = await service.findEntity(type, key);
        if (entity && !found.some((entry) => entry.entity.id === entity.id)) {
          found.push({ entity, records: await store.listRecords({ status: ["active"], entityIds: [entity.id], limit: 100 }) });
        }
      }
      return found;
    },
    tools: (ctx: DomainToolContext): ToolSet => memoryTools(ctx, service),
    remember: (input, who) => state(input, who, "supersede"),
    create: (input, who) => state(input, who, "reject"),
    propose,
    approve,
    reject,
    forget,
    edit,
    explain,
    search: (query, opts = {}) => store.searchRecords(query, { mode: "all", status: opts.status ?? ["active"], entityIds: opts.entityIds, type: opts.type, limit: opts.limit }),
    core,
    async findEntity(type, key) {
      try {
        return await store.findEntity(type, normalizeEntityKey(type, key));
      } catch {
        return null;
      }
    },
    importLegacy,
  };

  // Import once the whole hub is built and the orchestrator store is up; a failure is reported, never fatal.
  service.ready = Promise.resolve().then(() => hub.store.ready).then(async () => {
    await store.ready;
    if (options.importLegacy !== false) await importLegacy();
  }).catch((err: unknown) => console.error("Could not import the legacy memory notes:", err));
  return service;
}
