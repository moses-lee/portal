/**
 * The Memory browser's logic: entities grouped by type, an entity's records split into what is in
 * force, what waits in the inbox, and history, and a record's lineage through supersession.
 */
import { entityTypes, type EntityType, type MemoryEntity, type MemoryRecord } from "./types.ts";

export const entityTypeLabels: Record<EntityType, string> = {
  global: "Global",
  person: "People",
  repo: "Repositories",
  project: "Projects",
  session: "Sessions",
  task_type: "Task types",
};

export type EntityGroup = { type: EntityType; label: string; entities: MemoryEntity[]; records: number };

/** Every type that has entities, in the contract's order; entities by name within each. */
export function groupEntities(entities: readonly MemoryEntity[]): EntityGroup[] {
  return entityTypes.flatMap((type) => {
    const members = entities
      .filter((entity) => entity.type === type)
      .sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
    if (members.length === 0) return [];
    return [{
      type,
      label: entityTypeLabels[type],
      entities: members,
      records: members.reduce((sum, entity) => sum + entity.activeRecords, 0),
    }];
  });
}

export type RecordPartition = { active: MemoryRecord[]; proposed: MemoryRecord[]; history: MemoryRecord[] };

/** Active records pinned first then by key; proposed newest first; everything else (superseded, archived, …) newest first. */
export function partitionRecords(records: readonly MemoryRecord[]): RecordPartition {
  const active = records
    .filter((record) => record.status === "active")
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.key.localeCompare(b.key));
  const proposed = records.filter((record) => record.status === "proposed").sort((a, b) => b.createdAt - a.createdAt);
  const history = records
    .filter((record) => record.status !== "active" && record.status !== "proposed")
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return { active, proposed, history };
}

/**
 * The chain a record belongs to, oldest first: back through `supersedes`, forward through
 * `supersededBy`, as far as the known records reach. Guards against cycles.
 */
export function lineage(record: MemoryRecord, byId: ReadonlyMap<string, MemoryRecord>): MemoryRecord[] {
  const seen = new Set([record.id]);
  const before: MemoryRecord[] = [];
  let cursor = record.supersedes ? byId.get(record.supersedes) : undefined;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    before.unshift(cursor);
    cursor = cursor.supersedes ? byId.get(cursor.supersedes) : undefined;
  }
  const after: MemoryRecord[] = [];
  cursor = record.supersededBy ? byId.get(record.supersededBy) : undefined;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    after.push(cursor);
    cursor = cursor.supersededBy ? byId.get(cursor.supersededBy) : undefined;
  }
  return [...before, record, ...after];
}

/** Only the user's own word can be pinned into CORE.md as a directive. */
export function canPin(record: Pick<MemoryRecord, "authority">): boolean {
  return record.authority === "user_stated" || record.authority === "user_confirmed";
}

export const authorityLabels: Record<MemoryRecord["authority"], string> = {
  user_stated: "You said",
  user_confirmed: "You confirmed",
  observed: "Observed",
  inferred: "Inferred",
};
