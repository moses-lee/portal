/**
 * Pins keep chosen projects and sessions at the top of the sidebar, as id → epoch ms of when each
 * was pinned. Session pins are a per-browser preference held in localStorage. Project pins live on
 * the server (`Project.pinnedAt`), because pinned worktrees are never removed for being idle; the
 * project pins a browser kept before that are pushed to the server once (`migrateProjectPins`).
 */

export type PinMap = Readonly<Record<string, number>>;

export const EMPTY_PINS: PinMap = Object.freeze({});

/** Read a stored map back; anything malformed is treated as no pins. */
export function parsePins(text: string | null): PinMap {
  if (!text) return EMPTY_PINS;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return EMPTY_PINS; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return EMPTY_PINS;
  const pins: Record<string, number> = {};
  for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof at === "number" && Number.isFinite(at)) pins[id] = at;
  }
  return pins;
}

/** Pin `id` when it is not pinned, else unpin it. */
export function togglePin(pins: PinMap, id: string, now = Date.now()): PinMap {
  const next = { ...pins };
  if (id in next) delete next[id];
  else next[id] = now;
  return next;
}

/** Drop pins for ids that no longer exist. Returns the same map when nothing changed. */
export function prunePins(pins: PinMap, existing: Iterable<string>): PinMap {
  const keep = new Set(existing);
  const stale = Object.keys(pins).filter((id) => !keep.has(id));
  if (stale.length === 0) return pins;
  const next = { ...pins };
  for (const id of stale) delete next[id];
  return next;
}

/**
 * Pinned items first, most recently pinned on top (ties keep the given order), then the rest in
 * the given order.
 */
export function pinnedFirst<T extends { id: string }>(items: readonly T[], pins: PinMap): T[] {
  const pinned = items.filter((item) => item.id in pins);
  if (pinned.length === 0) return [...items];
  const rest = items.filter((item) => !(item.id in pins));
  pinned.sort((a, b) => pins[b.id] - pins[a.id]);
  return [...pinned, ...rest];
}

/** Pinned items first and the rest after, each part keeping the given order. */
export function partitionPinned<T extends { id: string }>(items: readonly T[], pins: PinMap): T[] {
  if (Object.keys(pins).length === 0) return [...items];
  return [...items.filter((item) => item.id in pins), ...items.filter((item) => !(item.id in pins))];
}

/** Project id → `pinnedAt`, for the projects the server reports as pinned. */
export function projectPinsOf(projects: readonly { id: string; pinnedAt?: number | null }[]): PinMap {
  const pins: Record<string, number> = {};
  for (const project of projects) if (typeof project.pinnedAt === "number") pins[project.id] = project.pinnedAt;
  return pins;
}

/** Where this browser kept its project pins before they moved to the server. */
export const LEGACY_PROJECT_PINS_KEY = "portal.pins.projects";

export type PinStorage = Pick<Storage, "getItem" | "removeItem">;

/**
 * What `migrateProjectPins` did: `done` when the local pins are on the server (or there were none)
 * and the local key is gone; `waiting` when it should run again with a later project list (a
 * server without `pinnedAt` yet, an empty list, or a push that failed). `pushed` counts the ids sent.
 */
export type PinMigration = { status: "done" | "waiting"; pushed: number };

/**
 * Push this browser's old project pins to the server, once: only against a project list in which
 * every project carries `pinnedAt` (null counts; the field missing means a server from before
 * server-side pins). Ids that no longer exist or are already pinned there are skipped; the rest are
 * pinned oldest first, so the most recently pinned one stays on top. The local key is deleted only
 * after every push landed; session pins are left alone.
 */
export async function migrateProjectPins(
  projects: readonly { id: string; pinnedAt?: number | null }[],
  storage: PinStorage,
  pin: (id: string) => Promise<unknown>,
): Promise<PinMigration> {
  if (projects.length === 0 || !projects.every((project) => "pinnedAt" in project)) return { status: "waiting", pushed: 0 };
  let local: PinMap;
  try {
    local = parsePins(storage.getItem(LEGACY_PROJECT_PINS_KEY));
  } catch {
    // Storage is unavailable, so there is nothing this browser could have kept.
    return { status: "done", pushed: 0 };
  }
  const unpinned = new Set(projects.filter((project) => project.pinnedAt == null).map((project) => project.id));
  const ids = Object.entries(local).filter(([id]) => unpinned.has(id)).sort((a, b) => a[1] - b[1]).map(([id]) => id);
  let pushed = 0;
  for (const id of ids) {
    try {
      await pin(id);
    } catch {
      // Pushing again is harmless (already pinned ids are skipped), so the next list retries the rest.
      return { status: "waiting", pushed };
    }
    pushed++;
  }
  try {
    storage.removeItem(LEGACY_PROJECT_PINS_KEY);
  } catch {
    // Left in place, the next run finds every id pinned already and pushes nothing.
  }
  return { status: "done", pushed };
}
