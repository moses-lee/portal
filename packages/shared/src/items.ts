import type { Item, ItemKind } from "@portal/contracts/orchestrator";

/**
 * Item kinds nothing creates any more (2026-09-29): the session states they raised show live in the
 * tracked-sessions panel instead. Old rows keep them; they never need the user's attention.
 */
export const retiredItemKinds: ReadonlySet<ItemKind> = new Set<ItemKind>([
  "session_finished",
  "session_stopped",
  "session_waiting",
  "session_offline",
  "session_hung",
]);

/**
 * Whether an item belongs on the Needs-your-attention page at `now` (epoch ms): not a retired kind,
 * and open, or snoozed with its snooze lapsed (or never timed). The server's `needsYou` count and
 * the page use this same rule, so the badge and the list always agree.
 */
export function needsAttention(item: Pick<Item, "kind" | "status" | "snoozedUntil">, now: number): boolean {
  if (retiredItemKinds.has(item.kind)) return false;
  if (item.status === "open") return true;
  return item.status === "snoozed" && (item.snoozedUntil === null || item.snoozedUntil <= now);
}
