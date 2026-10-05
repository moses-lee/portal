import type { Item, ItemKind } from "./types";

/** Approvals block work, so their group comes first; the rest follow their newest item. */
const PINNED_FIRST: ItemKind = "approval_needed";

/**
 * The Needs-you page's grouping: items by kind, the approvals group first, the other groups by
 * their newest item, and the items inside each group newest first.
 */
export function groupByKind(items: Item[]): { kind: ItemKind; items: Item[] }[] {
  const groups = new Map<ItemKind, Item[]>();
  for (const item of items) groups.set(item.kind, [...(groups.get(item.kind) ?? []), item]);
  const newest = (rows: Item[]) => Math.max(...rows.map((row) => row.updatedAt));
  return [...groups.entries()]
    .map(([kind, rows]) => ({ kind, items: [...rows].sort((a, b) => b.updatedAt - a.updatedAt) }))
    .sort((a, b) => {
      if ((a.kind === PINNED_FIRST) !== (b.kind === PINNED_FIRST)) return a.kind === PINNED_FIRST ? -1 : 1;
      return newest(b.items) - newest(a.items);
    });
}
