/**
 * Persistence for the workspace (docs/WORKSPACE.md): the one strip of tabs every device shows, kept
 * as one `settings` row (`key = 'workspace'`) beside the user's overrides and the last-used record.
 * The same load/save backend split and serialised mutation queue as `settings/last-used.ts`, so two
 * devices' operations never interleave their read-modify-write. `version` increments on every write.
 *
 * Loaded data goes through `validateWorkspace`: a missing row, or one that no longer satisfies the
 * invariants (a hand edit, a bug in an older build), reads as the empty workspace rather than
 * poisoning every later operation.
 */
import { eq } from "drizzle-orm";
import type { Workspace } from "@portal/contracts/workspace";
import { EMPTY_WORKSPACE, validateWorkspace } from "@portal/shared/workspace";
import type { Db } from "../db/client.ts";
import { stripNul } from "../db/sanitize.ts";
import { settings } from "../db/schema.ts";

/** The `settings` row that holds the workspace. */
export const WORKSPACE_KEY = "workspace";

export interface WorkspaceBackend {
  load(): Promise<unknown>;
  save(workspace: Workspace): Promise<void>;
}

export interface WorkspaceStore {
  read(): Promise<Workspace>;
  /**
   * Read, change, save, one caller at a time. `fn` answers the next workspace, or null to leave the
   * stored one alone (nothing is written then). The answer is what is stored afterwards: on a write,
   * `fn`'s result with `version` bumped. A throw from `fn` propagates and writes nothing.
   */
  mutate(fn: (current: Workspace) => Workspace | null): Promise<Workspace>;
}

/** `raw` as a workspace when it satisfies every invariant, else the empty one (`warn` says why). */
export function parseWorkspace(raw: unknown, warn: (message: string) => void = () => {}): Workspace {
  if (raw === null || raw === undefined) return EMPTY_WORKSPACE;
  try {
    validateWorkspace(raw);
    return raw;
  } catch (err) {
    warn(`Stored workspace is invalid and was reset: ${err instanceof Error ? err.message : String(err)}`);
    return EMPTY_WORKSPACE;
  }
}

export function createWorkspaceStore(backend: WorkspaceBackend, { warn = (message) => console.warn(message) }: { warn?: (message: string) => void } = {}): WorkspaceStore {
  // A corrupt row is read on every operation until something is written over it; one warning says so, not one per read.
  let warned = false;
  const warnOnce = (message: string) => {
    if (warned) return;
    warned = true;
    warn(message);
  };
  const read = async () => parseWorkspace(await backend.load(), warnOnce);

  // One chain for every write so concurrent operations never interleave their read-modify-write.
  let queue: Promise<unknown> = Promise.resolve();
  function mutate(fn: (current: Workspace) => Workspace | null): Promise<Workspace> {
    const run = queue.then(async () => {
      const current = await read();
      const next = fn(current);
      if (next === null) return current;
      const saved: Workspace = { ...next, version: current.version + 1 };
      await backend.save(saved);
      return saved;
    });
    queue = run.catch(() => {});
    return run;
  }

  return { read, mutate };
}

/** The workspace in memory, for tests; `seed` is stored as given (so a corrupt one can be tried). */
export function createMemoryWorkspaceStore(seed: unknown = null, options: { warn?: (message: string) => void } = {}): WorkspaceStore & { stored(): unknown; writes: number } {
  let body: unknown = structuredClone(seed);
  const handle = { writes: 0 };
  const store = createWorkspaceStore({
    load: async () => structuredClone(body),
    save: async (workspace) => {
      handle.writes++;
      body = structuredClone(workspace);
    },
  }, options);
  return Object.assign(handle, { ...store, stored: () => structuredClone(body) });
}

/** The workspace as one `settings` row (`key = 'workspace'`), read fresh on every call like the overrides. */
export function createPgWorkspaceStore(db: Db, options: { warn?: (message: string) => void } = {}): WorkspaceStore {
  return createWorkspaceStore({
    async load() {
      const [row] = await db.select({ body: settings.body }).from(settings).where(eq(settings.key, WORKSPACE_KEY));
      return row?.body ?? null;
    },
    async save(workspace) {
      // Tab titles are the user's text; jsonb rejects a NUL in any of them.
      const body = stripNul(workspace) as unknown as Record<string, unknown>;
      const now = Date.now();
      await db
        .insert(settings)
        .values({ key: WORKSPACE_KEY, body, updatedAt: now })
        .onConflictDoUpdate({ target: settings.key, set: { body, updatedAt: now } });
    },
  }, options);
}
