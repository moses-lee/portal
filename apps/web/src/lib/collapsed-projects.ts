/**
 * Which sidebar projects are collapsed: a per-browser preference held in localStorage as a JSON
 * array of project ids, so collapsing to declutter survives a reload.
 */

export const EMPTY_COLLAPSED: ReadonlySet<string> = new Set<string>();

/** Read a stored list back; anything malformed is treated as nothing collapsed. */
export function parseCollapsed(text: string | null): ReadonlySet<string> {
  if (!text) return EMPTY_COLLAPSED;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return EMPTY_COLLAPSED; }
  if (!Array.isArray(parsed)) return EMPTY_COLLAPSED;
  const ids = parsed.filter((id): id is string => typeof id === "string");
  return ids.length === 0 ? EMPTY_COLLAPSED : new Set(ids);
}

/** The storable form of a collapsed set. */
export function serializeCollapsed(ids: Iterable<string>): string {
  return JSON.stringify([...ids]);
}

/** Forget ids for projects that no longer exist. Returns the same set when nothing changed. */
export function pruneCollapsed(ids: ReadonlySet<string>, existing: Iterable<string>): ReadonlySet<string> {
  const keep = new Set(existing);
  const kept = [...ids].filter((id) => keep.has(id));
  return kept.length === ids.size ? ids : new Set(kept);
}
