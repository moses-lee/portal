/**
 * The silent world refresh the seeded `tick` job runs every hour (see `jobs/tick-job.ts`): one full
 * world build, GitHub included, whose diff against the previous snapshot feeds the change log and
 * releases dismissals whose condition cleared (the world service does both for every full build,
 * see `world/service.ts`), and then snoozed items whose time has passed are woken. No model is
 * called, nothing is posted to a thread, and no item is created or rewritten: what changed reaches
 * the user only through chat turns, which read the change log. Nothing here takes a thread lock.
 */
import type { OrchestratorHub } from "./hub.ts";

/** What one run of the refresh did; the run's `result`. */
export type RefreshReport = {
  /** Changes the diff found against the previous snapshot. */
  changes: number;
  /** Dismissed items resolved because their condition cleared. */
  released: string[];
  /** Snoozed items whose time had passed, open again. */
  woken: string[];
  /** Sources that could not be read and what was done, one line each. */
  log: string[];
  error: string | null;
};

export const emptyRefreshReport = (): RefreshReport => ({ changes: 0, released: [], woken: [], log: [], error: null });

/** Snoozed items whose time has passed, back to open; answers their ids. */
export async function wakeSnoozed(hub: Pick<OrchestratorHub, "store" | "timers" | "emit">): Promise<string[]> {
  const now = hub.timers.now();
  const woken: string[] = [];
  for (const item of await hub.store.listItems()) {
    if (item.status !== "snoozed" || item.snoozedUntil === null || item.snoozedUntil > now) continue;
    await hub.store.updateItem(item.id, { status: "open", snoozedUntil: null });
    woken.push(item.id);
  }
  if (woken.length > 0) hub.emit({ type: "items", items: await hub.store.listItems() });
  return woken;
}

/** Fill `report` with one refresh. Throws when the world could not be built at all; the job records it. */
export async function performRefresh(hub: OrchestratorHub, report: RefreshReport, { signal }: { signal: AbortSignal }): Promise<void> {
  const refreshed = await hub.world.update("tick");
  report.changes = refreshed.changes;
  report.released = refreshed.released;
  report.log.push(...refreshed.log);
  if (signal.aborted) return;
  report.woken = await wakeSnoozed(hub);
  if (report.woken.length > 0) report.log.push(`Woke ${report.woken.length} snoozed item(s).`);
}
