import { z } from "zod";
import type { TickReport } from "../types.ts";
import { type ToolContext, define } from "./context.ts";

function compactReport(report: TickReport) {
  const { id, reason, startedAt, finishedAt, modelInvoked, changes, itemsCreated, itemsUpdated, itemsResolved, error, usage } = report;
  return { id, reason, startedAt, finishedAt, modelInvoked, changes, itemsCreated, itemsUpdated, itemsResolved, error, usage, log: report.log.slice(0, 30) };
}

export function selfTools({ self }: ToolContext) {
  return {
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
