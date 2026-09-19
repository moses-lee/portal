import { z } from "zod";
import { MAX_MEMORY_BYTES } from "../store.ts";
import type { TickReport } from "../types.ts";
import { type ToolContext, define } from "./context.ts";

function compactReport(report: TickReport) {
  const { id, reason, startedAt, finishedAt, modelInvoked, changes, itemsCreated, itemsUpdated, itemsResolved, error, usage } = report;
  return { id, reason, startedAt, finishedAt, modelInvoked, changes, itemsCreated, itemsUpdated, itemsResolved, error, usage, log: report.log.slice(0, 30) };
}

export function selfTools({ store, self }: ToolContext) {
  return {
    read_memory: define("Your memory file: durable notes and user preferences, verbatim.", z.object({}), async () => ({ memory: await store.readMemory() })),
    write_memory: define(
      `Replace the memory file (Markdown; capped at ${MAX_MEMORY_BYTES / 1024} KiB).`,
      z.object({ text: z.string() }),
      async ({ text }) => {
        await store.writeMemory(text);
        return { bytes: Buffer.byteLength(await store.readMemory(), "utf8") };
      },
    ),
    append_memory: define(
      "Add one line to the memory file.",
      z.object({ line: z.string().min(1) }),
      async ({ line }) => {
        const current = await store.readMemory();
        await store.writeMemory(`${current.trimEnd()}${current.trim() ? "\n" : ""}${line.trim()}\n`);
        return { bytes: Buffer.byteLength(await store.readMemory(), "utf8") };
      },
    ),
    get_schedule: define("When ticks run: the intervals, how many browsers are connected, and the next and last tick times.", z.object({}), () => self.schedule()),
    get_last_tick: define("The most recent tick's report: what changed and what was created, updated, or resolved.", z.object({}), async () => ({ tick: await self.lastTick().then((report) => (report ? compactReport(report) : null)) })),
    get_tick_digest: define(
      "Scan sessions, pull requests, and worktrees now and diff against the last tick: what needs attention at this moment, without recording a tick.",
      z.object({}),
      async () => {
        // Memory is already in the system prompt.
        const { at, since, changes, dueWatches, openItems } = await self.digest();
        return { at, since, changes, dueWatches, openItems };
      },
    ),
  };
}
