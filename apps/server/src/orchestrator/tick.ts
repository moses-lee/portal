/**
 * One tick: read the world into a snapshot, diff it against the previous one, and when something
 * changed let the bookkeeping model turn the changes into items with the tick tool subset. The
 * report says what was considered and decided. The tick job (`jobs/tick-job.ts`) runs this and
 * records it as a run. Nothing here takes a thread lock: chat turns go on while a tick runs.
 */
import { randomUUID } from "node:crypto";
import { buildDigest } from "./digest.ts";
import type { OrchestratorHub } from "./hub.ts";
import { tickPrompt } from "./prompt.ts";
import type { ToolContext } from "./tools/index.ts";
import { generateTurn, prepareTurn } from "./turn.ts";
import type { Item, TickReport } from "./types.ts";
import { MAIN_THREAD_ID } from "./types.ts";

/** Which items changed between two listings, by what happened to them. */
export function itemDelta(before: Map<string, Item>, after: Item[]) {
  const delta = { created: [] as string[], updated: [] as string[], resolved: [] as string[] };
  for (const item of after) {
    const was = before.get(item.id);
    if (!was) delta.created.push(item.id);
    else if (was.updatedAt !== item.updatedAt) (item.status === "resolved" && was.status !== "resolved" ? delta.resolved : delta.updated).push(item.id);
  }
  return delta;
}

export type TickOptions = {
  self: ToolContext["self"];
  signal: AbortSignal;
  /** Keeps the stored thread bounded after a note was posted. */
  trimThread: (threadId: string) => Promise<void>;
};

/** Fill `report` by running one tick. Throws on a model failure; the caller records it. */
export async function performTick(hub: OrchestratorHub, report: TickReport, { self, signal, trimThread }: TickOptions): Promise<void> {
  const { store, timers } = hub;
  const { log } = report;
  const model = await hub.model("bookkeeping");
  if (!model) {
    const settings = await hub.settings.orchestrator();
    log.push(`No ${settings.bookkeeping.provider} API key is stored; nothing was checked.`);
    report.error = "not ready";
    return;
  }
  const previous = await store.readSnapshot();
  const now = timers.now();
  const before = new Map((await store.listItems()).map((item) => [item.id, item]));
  // One full world build serves the tick: its snapshot is what the digest diffs, and any source it
  // could not read is reported in the tick's log.
  const world = await hub.world.refresh("tick");
  log.push(...world.errors);
  const snapshot = world.snapshot;
  const digest = await buildDigest({ store, snapshot, prevSnapshot: previous, now });
  report.changes = digest.changes.length;
  for (const change of digest.changes) log.push(`${change.resolvesItemId ? "Cleared" : "Changed"}: ${change.summary} (${change.fingerprint})`);
  for (const fingerprint of digest.suppressed) log.push(`Left out, dismissed by the user: ${fingerprint}`);
  // A dismissal lasts while its condition does; once it cleared, the item is settled without the model.
  for (const id of digest.released) {
    await store.updateItem(id, { status: "resolved", snoozedUntil: null });
    log.push(`Released dismissed item ${id}: its condition cleared.`);
  }
  let keepSnapshot = false;

  if (digest.changes.length > 0) {
    const touched = new Set<string>();
    const prepared = await prepareTurn(hub, {
      kind: "tick", role: "bookkeeping", trigger: report.reason === "manual" ? "manual" : "schedule", threadId: MAIN_THREAD_ID,
      interactive: false, query: digest.changes.map((change) => change.summary).join("\n"), touched, self, summary: "Checking for changes",
    });
    if (!prepared) {
      log.push("The bookkeeping model has no key; nothing was checked.");
      report.error = "not ready";
      return;
    }
    report.modelInvoked = true;
    const result = await generateTurn(prepared, {
      prompt: tickPrompt(digest), signal,
      summarize: (text) => (text && text !== "NO_UPDATE" ? text.slice(0, 200) : `${digest.changes.length} change(s), nothing to report`),
    });
    report.usage = { inputTokens: result.usage?.inputTokens ?? 0, outputTokens: result.usage?.outputTokens ?? 0 };
    if (result.capped) {
      report.capped = true;
      const again = (await self.lastTick())?.capped === true;
      keepSnapshot = !again;
      log.push(again
        ? "The model hit its step cap again; moving on so the same changes do not loop."
        : "The model hit its step cap; the snapshot is kept so the next tick offers these changes again.");
    }
    if (result.text && result.text !== "NO_UPDATE") {
      await store.appendMessages([{
        id: randomUUID(), role: "assistant", parts: [{ type: "text", text: result.text }],
        metadata: { at: timers.now(), tick: { id: report.id, reason: report.reason }, run: { id: prepared.run.id, kind: "tick" }, itemIds: [...touched] },
      }], MAIN_THREAD_ID);
      await trimThread(MAIN_THREAD_ID);
      log.push("Posted a note to the thread.");
      hub.emit({ type: "messages", threadId: MAIN_THREAD_ID });
    } else {
      log.push("No note for the user (NO_UPDATE).");
    }
  } else {
    log.push("Nothing changed; the model was not invoked.");
  }
  if (!keepSnapshot) await store.writeSnapshot(snapshot);

  // What happened to items, read back from the store (snoozes waking up count too).
  const delta = itemDelta(before, await store.listItems());
  report.itemsCreated = delta.created;
  report.itemsUpdated = delta.updated;
  report.itemsResolved = delta.resolved;
  if (report.modelInvoked) log.push(`Items: ${delta.created.length} created, ${delta.updated.length} updated, ${delta.resolved.length} resolved.`);
  if (delta.created.length + delta.updated.length + delta.resolved.length > 0) hub.emit({ type: "items", items: await store.listItems() });
}
