/**
 * Where world builds are kept (`world_snapshots`): each full build is appended; the newest is the
 * current world after a restart, and the older ones are there for audits until pruned. The
 * in-memory store backs tests; `pg-store.ts` is the live one. Lists answer newest first.
 */
import type { WorldState } from "@portal/contracts/world";
import { stripNul } from "../../db/sanitize.ts";

/** Builds kept after a prune. */
export const KEEP_WORLD_BUILDS = 200;
export const DEFAULT_WORLD_LIST_LIMIT = 20;
export const MAX_WORLD_LIST_LIMIT = 100;

export type WorldBuild = { id: number; at: number; reason: string; world: WorldState };

export interface WorldStore {
  append(world: WorldState, reason: string): Promise<WorldBuild>;
  latest(): Promise<WorldBuild | null>;
  /** Newest first; `before` pages by id. */
  list(filter?: { before?: number; limit?: number }): Promise<WorldBuild[]>;
  /** Drop all but the newest `keep` builds; resolves with how many went. */
  prune(keep?: number): Promise<number>;
}

export function clampWorldLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_WORLD_LIST_LIMIT;
  return Math.max(1, Math.min(MAX_WORLD_LIST_LIMIT, Math.floor(limit)));
}

export function createMemoryWorldStore(): WorldStore {
  let builds: WorldBuild[] = [];
  let nextId = 1;
  return {
    async append(world, reason) {
      // A cleaned deep copy, as a database round trip would give: later edits of the object must not rewrite history.
      const build = { id: nextId++, at: world.at, reason, world: stripNul(world) };
      builds.push(build);
      return structuredClone(build);
    },
    async latest() {
      const last = builds.at(-1);
      return last ? structuredClone(last) : null;
    },
    async list(filter = {}) {
      const limit = clampWorldLimit(filter.limit);
      return builds.filter((b) => filter.before === undefined || b.id < filter.before).slice(-limit).reverse().map((b) => structuredClone(b));
    },
    async prune(keep = KEEP_WORLD_BUILDS) {
      const drop = Math.max(0, builds.length - Math.max(0, keep));
      builds = builds.slice(drop);
      return drop;
    },
  };
}
