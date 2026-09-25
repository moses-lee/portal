/**
 * World state: the service over the builder, the store, the change log, the renderer, and the
 * resolve tools. `refresh` runs a full build (GitHub included), diffs its snapshot against the
 * previous one into the change log (see `settle`), stores it, and emits `world`; refreshes that
 * overlap share one build. `update` is the same refresh with what its diff did, for the hourly
 * refresh job's run. `current` answers from memory (or the newest stored build after a
 * restart); once that is older than `staleMs` it rebuilds only the local slices (sessions,
 * projects, terminals, items, jobs, intents) and reuses the last PRs, so a chat turn never waits on
 * the network. Local rebuilds are kept in memory only; the store holds full builds.
 */
import type { WorldResponse, WorldState } from "@portal/contracts/world";
import { MAIN_THREAD_ID, type Scope } from "@portal/contracts/orchestrator";
import { type DismissalOutcome, diffSnapshots } from "../digest.ts";
import type { OrchestratorHub, WorldRefresh, WorldService } from "../hub.ts";
import { type WorldCache, buildWorld, createWorldCache } from "./builder.ts";
import { type ChangeStore, MAX_CHANGE_LIMIT, createMemoryChangeStore, recordChanges } from "./changes.ts";
import { createPgChangeStore, createPgWorldStore } from "./pg-store.ts";
import { RECENT_CHANGES_WINDOW_MS, previousAnswerAt, renderRecentChanges, selectRecentChanges, threadRefs } from "./recent.ts";
import { type RenderOptions, estimateTokens, renderWorld } from "./render.ts";
import type { PullLookupOptions } from "./resolve.ts";
import { KEEP_WORLD_BUILDS, type WorldBuild, type WorldStore, createMemoryWorldStore } from "./store.ts";
import { worldTools } from "./tools.ts";

/** How old the world may be before `current` rebuilds its local slices. */
export const WORLD_STALE_MS = 60_000;

export type WorldOptions = {
  /** Where builds are kept; Postgres when the hub has a database, else memory. */
  store?: WorldStore;
  /** Where the change log is kept; likewise. */
  changes?: ChangeStore;
  cache?: WorldCache;
  staleMs?: number;
  /** Builds kept by the prune after each stored build. */
  keep?: number;
  /** Concurrency and timeout of resolve_pull's per-repo GitHub lookups. */
  lookup?: PullLookupOptions;
};

export interface WorldDomainService extends WorldService {
  store: WorldStore;
  changes: ChangeStore;
  /** The current world, running the first full build when none was ever stored. */
  ensureBuilt(): Promise<WorldState>;
  /** The world with its rendering, as the routes answer. */
  response(world: WorldState, opts?: RenderOptions): WorldResponse;
  /** Stored builds, newest first, for audits. */
  builds(filter?: { before?: number; limit?: number }): Promise<WorldBuild[]>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createWorldService(hub: OrchestratorHub, options: WorldOptions = {}): WorldDomainService {
  const store = options.store ?? (hub.db ? createPgWorldStore({ db: hub.db }) : createMemoryWorldStore());
  const changes = options.changes ?? (hub.db ? createPgChangeStore({ db: hub.db }) : createMemoryChangeStore());
  const cache = options.cache ?? createWorldCache();
  const staleMs = options.staleMs ?? WORLD_STALE_MS;
  const keep = options.keep ?? KEEP_WORLD_BUILDS;

  /** The newest build, full or local. */
  let latest: WorldState | null = null;
  /** Whether a full build exists (made here or stored before), and when the newest was made. */
  let built = false;
  let fullAt: number | null = null;
  let loaded: Promise<void> | null = null;
  let fullBuild: Promise<WorldRefresh> | null = null;
  let localBuild: Promise<WorldState> | null = null;

  /** Adopt the newest stored build once, unless this process already built a newer world. */
  const load = () => loaded ??= store.latest().then((build) => {
    if (!build) return;
    built = true;
    fullAt = Math.max(fullAt ?? 0, build.at);
    if (!latest || build.at > latest.at) latest = build.world;
  }).catch((err: unknown) => {
    console.error("Could not read the stored world:", err);
  });

  const adopt = (world: WorldState) => {
    if (!latest || world.at >= latest.at) latest = world;
  };

  /**
   * The diff every full build ends with, whoever asked for it: against the stored snapshot, what
   * changed goes to the change log, a dismissed item whose condition cleared is released (resolved;
   * the dismissal has done its job), and the build's snapshot becomes the reference for the next
   * one. Never throws.
   */
  async function settle(world: WorldState): Promise<Omit<WorldRefresh, "world">> {
    const log = [...world.errors];
    const outcome = { changes: 0, released: [] as string[], log };
    try {
      const previous = await hub.store.readSnapshot();
      const items = (await hub.store.listItems()).filter((item) => item.status !== "resolved");
      const dismissals: DismissalOutcome = { released: [], suppressed: [] };
      diffSnapshots(previous, world.snapshot, items, dismissals);
      // A change log that cannot be written costs this refresh's changes, not the snapshot or the releases.
      outcome.changes = await recordChanges(changes, previous, world).catch((err: unknown) => {
        log.push(`The change log could not be written (${errorMessage(err)}).`);
        return 0;
      });
      for (const id of dismissals.released) {
        await hub.store.updateItem(id, { status: "resolved", snoozedUntil: null });
        outcome.released.push(id);
        log.push(`Released dismissed item ${id}: its condition cleared.`);
      }
      await hub.store.writeSnapshot(world.snapshot);
      if (outcome.released.length > 0) hub.emit({ type: "items", items: await hub.store.listItems() });
    } catch (err) {
      log.push(`The snapshot could not be diffed (${errorMessage(err)}).`);
    }
    return outcome;
  }

  function update(reason: string): Promise<WorldRefresh> {
    fullBuild ??= (async () => {
      await load();
      const world = await buildWorld({ hub, previous: latest, mode: "full", cache });
      adopt(world);
      built = true;
      fullAt = Math.max(fullAt ?? 0, world.at);
      const outcome = await settle(world);
      try {
        await store.append(world, reason);
        await store.prune(keep);
      } catch (err) {
        console.error(`Could not store the world (${errorMessage(err)}).`);
      }
      hub.emit({ type: "world", at: world.at });
      return { world, ...outcome };
    })().finally(() => { fullBuild = null; });
    return fullBuild;
  }

  const refresh = (reason: string) => update(reason).then(({ world }) => world);

  function refreshLocal(): Promise<WorldState> {
    localBuild ??= (async () => {
      const world = await buildWorld({ hub, previous: latest, mode: "local", cache });
      adopt(world);
      return latest ?? world;
    })().finally(() => { localBuild = null; });
    return localBuild;
  }

  async function current(): Promise<WorldState | null> {
    await load();
    if (latest && hub.timers.now() - latest.at < staleMs) return latest;
    try {
      return await refreshLocal();
    } catch (err) {
      console.error(`Could not rebuild the world (${errorMessage(err)}).`);
      return latest;
    }
  }

  const render = (world: WorldState, opts?: RenderOptions) => renderWorld(world, opts);

  async function recentChanges({ threadId, scope }: { threadId: string | null; scope: Scope }): Promise<string> {
    const now = hub.timers.now();
    const messages = await hub.store.readMessages(threadId ?? MAIN_THREAD_ID);
    const since = previousAnswerAt(messages) ?? now - RECENT_CHANGES_WINDOW_MS;
    const [rows, items, intents] = await Promise.all([
      changes.list({ since, limit: MAX_CHANGE_LIMIT }), hub.store.listItems(), hub.jobs.listIntents({ status: ["active"] }),
    ]);
    if (rows.length === 0) return "";
    const dismissed = new Set(items.filter((item) => item.status === "dismissed").map((item) => item.fingerprint));
    const selected = selectRecentChanges({ rows, now, since, refs: threadRefs({ scope, messages, items }), intents, dismissed });
    return renderRecentChanges(selected, now);
  }

  const service: WorldDomainService = {
    ready: Promise.resolve(),
    store,
    changes,
    current,
    refresh,
    update,
    async lastFullAt() {
      await load();
      return fullAt;
    },
    recentChanges,
    render,
    async ensureBuilt() {
      await load();
      if (!built) return refresh("first request");
      return (await current()) ?? refresh("first request");
    },
    response(world, opts) {
      const rendered = render(world, opts);
      return { world, rendered, tokens: estimateTokens(rendered) };
    },
    builds: (filter) => store.list(filter),
    tools: (ctx) => worldTools(ctx, service, options.lookup),
  };
  return service;
}
