/**
 * The memory tools. A chat turn gets all five; a background turn only proposes and searches (it
 * has no user to speak for, and every schema costs tokens on each step). A curation turn (the
 * consolidator) also gets `submit_curation_plan`, the only way its decisions reach the server. `remember` and `forget`
 * speak for the user, so they need a `quote` that appears in the user's latest message of the
 * turn's thread, read from the store: text the model saw in a PR, a transcript, or a tool's output
 * can never become a user-stated claim or retract one.
 */
import { z } from "zod";
import { entityTypes, recordTypes, type MemoryEntity, type MemoryRecord } from "@portal/contracts/memory";
import type { DomainToolContext, ToolSet } from "../hub.ts";
import { define } from "../tools/context.ts";
import { pullRefSchema } from "../tools/items.ts";
import type { OrchestratorMessage } from "../types.ts";
import { entityLabel } from "./core.ts";
import { curationPlanSchema } from "./curation.ts";
import type { Actor, CuratedMemoryService } from "./service.ts";

const entitySchema = z.object({
  type: z.enum(entityTypes as [string, ...string[]]).describe("global; person (GitHub login); repo (owner/name); project or session (Portal id); task_type (slug such as code-review)"),
  key: z.string().min(1).describe('The natural key: "global", a login, "owner/name", a Portal id, or a task-type slug.'),
  name: z.string().optional().describe("Display name, when creating the entity."),
});

const scopeSchema = z.object({
  repos: z.array(z.string()).optional(),
  people: z.array(z.string()).optional(),
  taskTypes: z.array(z.string()).optional(),
  projectIds: z.array(z.string()).optional(),
  sessionIds: z.array(z.string()).optional(),
}).optional().describe("Where else the claim applies, beyond its entity.");

const claimFields = {
  entity: entitySchema,
  type: z.enum(recordTypes as [string, ...string[]]).describe("preference, feedback, convention, fact, procedure (how to do a task), or reference"),
  key: z.string().min(1).describe('A stable slug within the entity, e.g. "review-style" or "preferred-model.code-review". The same key replaces the old claim.'),
  body: z.string().min(1).describe("One claim, in a sentence or two (a procedure may list short steps)."),
  scope: scopeSchema,
};

const MAX_ROWS = 20;

/** Lowercase, straight quotes, single spaces: how quotes are compared with what the user typed. */
function normalize(text: string): string {
  return text.normalize("NFKC").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();
}

const textOf = (message: OrchestratorMessage) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

/**
 * The user's latest message in the turn's thread, when `quote` is a real excerpt of it. Throws a
 * message the model can act on otherwise.
 */
async function requireQuote({ hub, turn }: DomainToolContext, quote: string): Promise<{ messageId: string; quote: string }> {
  const trimmed = quote.trim().replace(/^["'“‘]+|["'”’]+$/g, "").trim();
  if (normalize(trimmed).length < 3) throw new Error("quote must be the user's own words (at least a few characters) from their latest message.");
  if (!turn.threadId) throw new Error("This turn has no thread with a user message to quote.");
  const messages = await hub.store.readMessages(turn.threadId);
  const latest = messages.findLast((message) => message.role === "user");
  if (!latest || !normalize(textOf(latest)).includes(normalize(trimmed))) {
    throw new Error("quote does not appear in the user's latest message. Only what the user just said can be remembered or forgotten as theirs; propose_memory the claim instead, quoting its source.");
  }
  return { messageId: latest.id, quote: trimmed };
}

function recordRow(record: MemoryRecord, entity?: MemoryEntity | null) {
  const body = record.body.length > 300 ? `${record.body.slice(0, 299)}…` : record.body;
  return {
    id: record.id, entity: entity ? entityLabel(entity) : record.entityId, type: record.type, key: record.key, status: record.status,
    authority: record.authority, ...(record.pinned ? { pinned: true } : {}), body,
  };
}

export function memoryTools(ctx: DomainToolContext, memory: CuratedMemoryService): ToolSet {
  const { turn } = ctx;
  const who: Actor = { actor: "agent", runId: turn.runId, threadId: turn.threadId };

  const tools: ToolSet = {
    propose_memory: define(
      "Put a claim you observed or inferred (in a session, a PR, a tool's output, or something the user implied) into the memory inbox; it applies only once the user approves it. Quote the words it rests on in source.quote.",
      z.object({
        ...claimFields,
        authority: z.enum(["observed", "inferred"]).describe("observed: seen in the user's work; inferred: your conclusion from it"),
        source: z.object({
          kind: z.enum(["session", "pull", "tool", "message"]),
          sessionId: z.string().optional(),
          pull: pullRefSchema.optional(),
          url: z.string().optional(),
          quote: z.string().min(1).describe("The words the claim rests on, verbatim and short."),
        }),
      }),
      async ({ source, ...input }) => {
        const result = await memory.propose({
          ...input, type: input.type as MemoryRecord["type"], entity: { ...input.entity, type: input.entity.type as MemoryEntity["type"] },
          source: { ...source, runId: turn.runId, ...(turn.threadId && source.kind === "message" ? { threadId: turn.threadId } : {}) },
        }, who);
        return { ...recordRow(result.record), ...(result.unchanged ? { unchanged: true } : {}) };
      },
    ),
    search_memory: define(
      "Search curated memory (key and body, full text). Filter by entity; status defaults to active (proposed is the inbox).",
      z.object({
        query: z.string().min(1),
        entity: entitySchema.optional(),
        status: z.enum(["active", "proposed", "any"]).optional(),
        limit: z.number().int().min(1).max(MAX_ROWS).optional(),
      }),
      async ({ query, entity, status, limit }) => {
        const found = entity ? await memory.findEntity(entity.type as MemoryEntity["type"], entity.key) : null;
        if (entity && !found) return { records: [] };
        const hits = await memory.search(query, {
          entityIds: found ? [found.id] : undefined, limit: (limit ?? 10) + 1,
          status: status === "any" ? ["active", "proposed", "superseded", "archived", "rejected", "expired"] : [status ?? "active"],
        });
        const entities = new Map((await memory.store.listEntities({ ids: [...new Set(hits.map((hit) => hit.record.entityId))] })).map((e) => [e.id, e]));
        const rows = hits.slice(0, limit ?? 10).map((hit) => recordRow(hit.record, entities.get(hit.record.entityId)));
        return { records: rows, truncated: hits.length > rows.length };
      },
    ),
  };
  if (turn.kind === "consolidate") {
    tools.submit_curation_plan = define(
      "Submit this curation pass's plan: a decision per inbox record you have a view on, the entity summaries, and an optional note. Portal validates it and applies what the rules allow when the pass ends; the answer says what it would ignore or refuse. Calling again replaces the plan.",
      curationPlanSchema,
      async (plan) => {
        const resolved = await memory.submitCurationPlan(turn.runId, plan);
        return {
          accepted: { promote: resolved.promote.length, supersede: resolved.promote.filter((entry) => entry.replaces).length, reject: resolved.reject.length, summaries: resolved.summaries.length },
          left: resolved.left.length, expire: resolved.expire.length, reconfirm: resolved.reconfirm.length,
          ...(resolved.issues.length ? { issues: resolved.issues.slice(0, MAX_ROWS) } : {}),
          ...(resolved.refused ? { refused: `${resolved.refused} Remove less, or leave more for the user.` } : {}),
        };
      },
    );
  }
  if (turn.origin !== "chat") return tools;

  return {
    ...tools,
    remember: define(
      "Remember a claim the user just stated (a preference, a convention, how they want a task done). It applies at once and replaces any active claim with the same entity and key. quote must be the user's own words from their latest message.",
      z.object({
        ...claimFields,
        quote: z.string().min(1).describe("The user's words from their latest message that state this claim, verbatim."),
        pinned: z.boolean().optional().describe("Pin as a standing directive in CORE.md; only when the user asks for an always-on rule."),
      }),
      async ({ quote, ...input }) => {
        const excerpt = await requireQuote(ctx, quote);
        const result = await memory.remember({
          ...input, type: input.type as MemoryRecord["type"], entity: { ...input.entity, type: input.entity.type as MemoryEntity["type"] },
          source: { kind: "message", threadId: turn.threadId ?? undefined, messageId: excerpt.messageId, runId: turn.runId, quote: excerpt.quote },
        }, who);
        return { ...recordRow(result.record), ...(result.superseded ? { superseded: result.superseded.id } : {}), ...(result.unchanged ? { unchanged: true } : {}) };
      },
    ),
    explain_memory: define(
      "The evidence behind a memory record: its source and quote, who changed it and when, and the claims it replaced or was replaced by.",
      z.object({ id: z.string().min(1) }),
      async ({ id }) => {
        const { record, entity, revisions, lineage } = await memory.explain(id);
        return {
          record: { ...recordRow(record, entity), body: record.body, trust: record.trust, scope: record.scope, source: record.source, createdAt: record.createdAt },
          revisions: revisions.slice(0, MAX_ROWS).map((revision) => ({ at: revision.at, actor: revision.actor, action: revision.action, reason: revision.reason })),
          earlier: lineage.earlier.map((older) => ({ id: older.id, status: older.status, body: older.body.slice(0, 200) })),
          replacedBy: lineage.replacedBy ? { id: lineage.replacedBy.id, status: lineage.replacedBy.status } : null,
        };
      },
    ),
    forget: define(
      "Retract a memory record the user asked you to forget; it is archived with the reason, and its history stays. quote must be the user's words from their latest message asking for it.",
      z.object({ id: z.string().min(1), reason: z.string().min(1).max(300), quote: z.string().min(1) }),
      async ({ id, reason, quote }) => {
        await requireQuote(ctx, quote);
        return recordRow(await memory.forget(id, reason, who));
      },
    ),
  };
}
