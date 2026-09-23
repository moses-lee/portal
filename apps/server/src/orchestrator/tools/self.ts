import { z } from "zod";
import type { TickReport } from "../types.ts";
import { type ToolContext, define } from "./context.ts";

function compactReport(report: TickReport) {
  const { id, reason, startedAt, finishedAt, modelInvoked, changes, itemsCreated, itemsUpdated, itemsResolved, error, usage } = report;
  return { id, reason, startedAt, finishedAt, modelInvoked, changes, itemsCreated, itemsUpdated, itemsResolved, error, usage, log: report.log.slice(0, 30) };
}

export function selfTools({ self }: ToolContext) {
  return {
    get_last_tick: define("The most recent tick's report: what changed and what was created, updated, or resolved.", z.object({}), async () => ({ tick: await self.lastTick().then((report) => (report ? compactReport(report) : null)) })),
    get_tick_digest: define(
      "Scan sessions, pull requests, and worktrees now and diff against the last tick: what needs attention at this moment, without recording a tick.",
      z.object({}),
      async () => {
        // Memory is already in the system prompt.
        const { at, since, changes, openItems } = await self.digest();
        return { at, since, changes, openItems };
      },
    ),
  };
}
