/**
 * The agent the user last picked and, per agent, the settings they last left it with (model, mode,
 * effort, …). Global, not per project. The start page starts from these, and so do the sessions the
 * orchestrator starts. Kept apart from the user's settings (`overrides`): nothing here is a
 * preference the user edits, it only follows what they pick.
 *
 * Written only by the user's own picks: the start page (`PATCH /api/last-used`) and the Agent
 * settings dialog (`POST /api/sessions/:id/config`, see sessions/routes.ts). Changes an agent makes
 * on its own and the orchestrator's `set_session_config` go straight to the runtime and never here.
 */
import { eq } from "drizzle-orm";
import { parseLastUsed, parseSettingsRecord, recordUserChange, settingsOf } from "@portal/shared/agent-settings";
import type { LastUsedAgents, LastUsedPatch } from "@portal/shared/agent-settings";
import type { Db } from "../db/client.ts";
import { stripNul } from "../db/sanitize.ts";
import { settings } from "../db/schema.ts";
import { httpError } from "../http/errors.ts";
import type { SessionListState, SetConfigRequest } from "../lib/types.ts";

/** The `settings` row that holds the record (beside `overrides`). */
export const LAST_USED_KEY = "last_used";

export interface LastUsedStore {
  read(): Promise<LastUsedAgents>;
  /** The settings the user last left `agentId` with, or null when there are none yet. */
  agentSettings(agentId: string): Promise<SessionListState | null>;
  /** Apply a validated patch (see `parseLastUsedPatch`); answers the whole record. */
  patch(patch: LastUsedPatch): Promise<LastUsedAgents>;
  /** The user changed one setting of an `agentId` session to `request`, and the agent answered `result`. */
  recordChange(agentId: string, result: SessionListState, request: SetConfigRequest): Promise<void>;
}

export interface LastUsedBackend {
  load(): Promise<unknown>;
  save(record: LastUsedAgents): Promise<void>;
}

/**
 * `PATCH /api/last-used`'s body, or a 400. `agents` is the ids the server can start; a pick or a
 * record for any other agent is refused.
 */
export function parseLastUsedPatch(body: unknown, agents: readonly string[]): LastUsedPatch {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw httpError("Expected a JSON object.", 400);
  const { agentId, settings: records, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length) throw httpError(`Unknown field "${Object.keys(rest)[0]}".`, 400);
  const known = (id: unknown): id is string => typeof id === "string" && agents.includes(id);
  const patch: LastUsedPatch = {};
  if (agentId !== undefined) {
    if (!known(agentId)) throw httpError(`Unknown agent "${String(agentId)}".`, 400);
    patch.agentId = agentId;
  }
  if (records !== undefined) {
    if (!records || typeof records !== "object" || Array.isArray(records)) throw httpError("settings must be an object of agent id to settings.", 400);
    patch.settings = {};
    for (const [id, record] of Object.entries(records)) {
      if (!known(id)) throw httpError(`Unknown agent "${id}".`, 400);
      const parsed = parseSettingsRecord(record);
      if (!parsed) throw httpError(`settings.${id} must be {modes, configOptions} as a session's state has them.`, 400);
      patch.settings[id] = parsed;
    }
  }
  return patch;
}

export function createLastUsedStore(backend: LastUsedBackend): LastUsedStore {
  // One chain for every write so concurrent changes never interleave their read-modify-write.
  let queue: Promise<unknown> = Promise.resolve();
  function mutate(fn: (current: LastUsedAgents) => LastUsedAgents): Promise<LastUsedAgents> {
    const run = queue.then(async () => {
      const next = fn(parseLastUsed(await backend.load()));
      await backend.save(next);
      return next;
    });
    queue = run.catch(() => {});
    return run;
  }

  const read = async () => parseLastUsed(await backend.load());

  return {
    read,
    agentSettings: async (agentId) => (await read()).settings[agentId] ?? null,
    patch: (patch) =>
      mutate((current) => ({
        agentId: patch.agentId ?? current.agentId,
        settings: { ...current.settings, ...patch.settings },
      })),
    recordChange: async (agentId, result, request) => {
      await mutate((current) => ({
        ...current,
        settings: { ...current.settings, [agentId]: recordUserChange(current.settings[agentId] ?? null, settingsOf(result), request) },
      }));
    },
  };
}

/** The record in memory, for tests; `seed` is stored as given. */
export function createMemoryLastUsedStore(seed: unknown = null): LastUsedStore & { stored(): unknown } {
  let body: unknown = structuredClone(seed);
  const store = createLastUsedStore({
    load: async () => structuredClone(body),
    save: async (record) => {
      body = structuredClone(record);
    },
  });
  return { ...store, stored: () => structuredClone(body) };
}

/** The record as one `settings` row (`key = 'last_used'`), read fresh every time like the overrides. */
export function createPgLastUsedStore(db: Db): LastUsedStore {
  return createLastUsedStore({
    async load() {
      const [row] = await db.select({ body: settings.body }).from(settings).where(eq(settings.key, LAST_USED_KEY));
      return row?.body ?? null;
    },
    async save(record) {
      // Option names come from the agent; jsonb rejects a NUL in any of them.
      const body = stripNul(record) as unknown as Record<string, unknown>;
      const now = Date.now();
      await db
        .insert(settings)
        .values({ key: LAST_USED_KEY, body, updatedAt: now })
        .onConflictDoUpdate({ target: settings.key, set: { body, updatedAt: now } });
    },
  });
}
