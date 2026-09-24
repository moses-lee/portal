/**
 * What memory puts into a prompt. `buildCore` writes CORE.md: the pinned directives, then one index
 * line per entity with active records, within a token budget. `rankRetrieved` and `renderRetrieved`
 * pick and render the tail for one turn: records of the entities the turn is about, plus full-text
 * matches on its text, best first, within their own budget. Both are pure; the service feeds them.
 */
import type { CoreDocument, MemoryEntity, MemoryRecord } from "@portal/contracts/memory";

/** CORE.md's budget: small, since every turn pays for it. */
export const CORE_BUDGET_TOKENS = 1200;
/** The retrieved tail's budget. */
export const RETRIEVED_BUDGET_TOKENS = 1500;
/** Longest directive body quoted in CORE.md; the rest is one explain_memory away. */
export const MAX_DIRECTIVE_CHARS = 300;
/** Longest body in the retrieved tail. */
export const MAX_RETRIEVED_BODY_CHARS = 600;
/** Keys listed on one index line before "…". */
export const INDEX_KEYS = 8;

/** How many times a claim was seen: its source plus its sightings. */
export const timesSeen = (record: Pick<MemoryRecord, "sightings">) => 1 + (record.sightings?.length ?? 0);

/** A rough token count (four characters a token), enough for budgets. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

const oneLine = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** "repo acme/app", "project p1 (app)", "global". */
export function entityLabel(entity: Pick<MemoryEntity, "type" | "key" | "name">): string {
  if (entity.type === "global") return "global";
  const named = entity.name && entity.name !== entity.key ? ` (${entity.name})` : "";
  return `${entity.type} ${entity.key}${named}`;
}

/** Lines added while they fit `budget` characters; the overflow is counted for a closing note. */
function fit(lines: string[], budget: number): { kept: string[]; dropped: number; used: number } {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > budget) break;
    kept.push(line);
    used += line.length + 1;
  }
  return { kept, dropped: lines.length - kept.length, used };
}

export function buildCore({ entities, active, now, budgetTokens = CORE_BUDGET_TOKENS }: {
  entities: MemoryEntity[];
  /** Every active record. */
  active: MemoryRecord[];
  now: number;
  budgetTokens?: number;
}): CoreDocument {
  if (active.length === 0) return { text: "", generatedAt: now, tokens: 0 };
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const budget = budgetTokens * 4;
  const parts: string[] = [];

  const pinned = active.filter((record) => record.pinned).sort((a, b) => a.createdAt - b.createdAt);
  let used = 0;
  if (pinned.length) {
    const header = "Directives (pinned by the user; follow them):";
    const lines = pinned.map((record) => {
      const entity = byId.get(record.entityId);
      const note = record.type === "procedure" ? " (procedure: interpret it, do not paste it)" : "";
      return `- [${record.id}] ${entity ? entityLabel(entity) : record.entityId} · ${record.key}${note}: ${oneLine(record.body, MAX_DIRECTIVE_CHARS)}`;
    });
    // Directives come first but leave room for the index.
    const { kept, dropped, used: size } = fit(lines, Math.floor(budget * 0.6) - header.length);
    parts.push(header, ...kept);
    if (dropped) parts.push(`- … ${dropped} more pinned (search_memory finds them)`);
    used += header.length + size + 60;
  }

  const byEntity = new Map<string, string[]>();
  for (const record of active) byEntity.set(record.entityId, [...(byEntity.get(record.entityId) ?? []), record.key]);
  const indexed = entities.filter((entity) => byEntity.has(entity.id));
  const header = "Index (entity — active records; search_memory and explain_memory read them):";
  const lines = indexed.map((entity) => {
    const keys = [...new Set(byEntity.get(entity.id) ?? [])].sort();
    const shown = keys.slice(0, INDEX_KEYS).join(", ");
    const count = byEntity.get(entity.id)?.length ?? 0;
    return `- ${entityLabel(entity)} — ${count} record${count === 1 ? "" : "s"}: ${shown}${keys.length > INDEX_KEYS ? ", …" : ""}`;
  });
  const { kept, dropped } = fit(lines, budget - used - header.length - 60);
  if (parts.length) parts.push("");
  parts.push(header, ...kept);
  if (dropped) parts.push(`- … ${dropped} more entities`);
  const text = parts.join("\n");
  return { text, generatedAt: now, tokens: estimateTokens(text) };
}

// ---------------------------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------------------------

/** How much being about the turn's entity counts, by how specific the entity is. */
const specificity: Record<MemoryEntity["type"], number> = { session: 3, project: 2.5, repo: 2.5, person: 2.5, task_type: 2.5, global: 1 };

export type Candidate = { record: MemoryRecord; score: number };

/**
 * Records of the scoped entities and full-text hits, merged and ranked: scope by specificity, a
 * text match by its rank relative to the best one, trust as the tiebreaker. Pinned records are left
 * out (CORE.md already carries them).
 */
export function rankRetrieved({ scoped, hits, entities }: {
  scoped: MemoryRecord[];
  hits: { record: MemoryRecord; rank: number }[];
  entities: Map<string, MemoryEntity>;
}): MemoryRecord[] {
  const candidates = new Map<string, Candidate>();
  const add = (record: MemoryRecord, score: number) => {
    if (record.pinned || record.status !== "active") return;
    const current = candidates.get(record.id);
    candidates.set(record.id, { record, score: (current?.score ?? record.trust * 0.5) + score });
  };
  for (const record of scoped) add(record, specificity[entities.get(record.entityId)?.type ?? "global"]);
  const best = Math.max(0, ...hits.map((hit) => hit.rank));
  for (const hit of hits) add(hit.record, 1 + (best > 0 ? hit.rank / best : 0));
  return [...candidates.values()].sort((a, b) => b.score - a.score || b.record.updatedAt - a.record.updatedAt).map((candidate) => candidate.record);
}

export function renderRecordLine(record: MemoryRecord, entity: MemoryEntity | undefined, maxBody = MAX_RETRIEVED_BODY_CHARS): string {
  const kind = record.type === "procedure" ? "procedure (interpret it, do not paste it)" : record.type;
  return `- [${record.id}] ${kind} · ${entity ? entityLabel(entity) : record.entityId} · ${record.key} (${record.authority}): ${oneLine(record.body, maxBody)}`;
}

export function renderRetrieved(records: MemoryRecord[], entities: Map<string, MemoryEntity>, budgetTokens = RETRIEVED_BUDGET_TOKENS): string {
  if (records.length === 0) return "";
  const lines = records.map((record) => renderRecordLine(record, entities.get(record.entityId)));
  const { kept, dropped } = fit(lines, budgetTokens * 4 - 60);
  if (dropped) kept.push(`- … ${dropped} more (search_memory finds them)`);
  return kept.join("\n");
}
