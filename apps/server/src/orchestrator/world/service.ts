/**
 * World state: the service over the builder, the store, the renderer, and the resolve tools.
 * `refresh` runs a full build (GitHub included), stores it, and emits `world`; refreshes that
 * overlap share one build. `current` answers from memory (or the newest stored build after a
 * restart); once that is older than `staleMs` it rebuilds only the local slices (sessions,
 * projects, terminals, items, jobs, intents) and reuses the last PRs, so a chat turn never waits on
 * the network. Local rebuilds are kept in memory only; the store holds full builds.
 */
import type { WorldResponse, WorldState } from "@portal/contracts/world";
import type { OrchestratorHub, WorldService } from "../hub.ts";
import { type WorldCache, buildWorld, createWorldCache } from "./builder.ts";
import { createPgWorldStore } from "./pg-store.ts";
import { type RenderOptions, estimateTokens, renderWorld } from "./render.ts";
import type { PullLookupOptions } from "./resolve.ts";
import { KEEP_WORLD_BUILDS, type WorldBuild, type WorldStore, createMemoryWorldStore } from "./store.ts";
import { worldTools } from "./tools.ts";

/** How old the world may be before `current` rebuilds its local slices. */
export const WORLD_STALE_MS = 60_000;

export type WorldOptions = {
  /** Where builds are kept; Postgres when the hub has a database, else memory. */
  store?: WorldStore;
  cache?: WorldCache;
  staleMs?: number;
  /** Builds kept by the prune after each stored build. */
  keep?: number;
  /** Concurrency and timeout of resolve_pull's per-repo GitHub lookups. */
  lookup?: PullLookupOptions;
};

export interface WorldDomainService extends WorldService {
  store: WorldStore;
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
  const cache = options.cache ?? createWorldCache();
  const staleMs = options.staleMs ?? WORLD_STALE_MS;
  const keep = options.keep ?? KEEP_WORLD_BUILDS;

  /** The newest build, full or local. */
  let latest: WorldState | null = null;
  /** Whether a full build exists (made here or stored before). */
  let built = false;
  let loaded: Promise<void> | null = null;
  let fullBuild: Promise<WorldState> | null = null;
  let localBuild: Promise<WorldState> | null = null;

  /** Adopt the newest stored build once, unless this process already built a newer world. */
  const load = () => loaded ??= store.latest().then((build) => {
    if (!build) return;
    built = true;
    if (!latest || build.at > latest.at) latest = build.world;
  }).catch((err: unknown) => {
    console.error("Could not read the stored world:", err);
  });

  const adopt = (world: WorldState) => {
    if (!latest || world.at >= latest.at) latest = world;
  };

  function refresh(reason: string): Promise<WorldState> {
    fullBuild ??= (async () => {
      await load();
      const world = await buildWorld({ hub, previous: latest, mode: "full", cache });
      adopt(world);
      built = true;
      try {
        await store.append(world, reason);
        await store.prune(keep);
      } catch (err) {
        console.error(`Could not store the world (${errorMessage(err)}).`);
      }
      hub.emit({ type: "world", at: world.at });
      return world;
    })().finally(() => { fullBuild = null; });
    return fullBuild;
  }

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

  const service: WorldDomainService = {
    ready: Promise.resolve(),
    store,
    current,
    refresh,
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
