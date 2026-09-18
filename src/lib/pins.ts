/**
 * Pins keep chosen projects and sessions at the top of the sidebar. They are a per-browser
 * preference held in localStorage, one map per kind: id → epoch ms of when it was pinned.
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
