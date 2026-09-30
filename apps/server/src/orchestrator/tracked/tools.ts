/**
 * The tracked-session tools a chat turn always has (the `tracked` tool group): `track_session`,
 * `untrack_session`, and `list_tracked_sessions`. Tracking and untracking go through the tracked
 * service, which logs each change to the activity view with the turn's run and thread; the list is
 * the world's tracked set (the same one the World section shows) with each session's live row.
 */
import type { TrackedSession } from "@portal/contracts/orchestrator";
import { z } from "zod";
import type { DomainToolContext, ToolSet } from "../hub.ts";
import { requireSession } from "../ops.ts";
import { define } from "../tools/context.ts";
import { sessionRow } from "../tools/sessions.ts";

const sessionId = z.string().min(1);

/** The turn's run and thread, for the activity entry of a track or untrack. */
export function trackContext(ctx: Pick<DomainToolContext, "turn">, reason?: string) {
  return { runId: ctx.turn.runId, ...(ctx.turn.threadId ? { threadId: ctx.turn.threadId } : {}), ...(reason?.trim() ? { reason: reason.trim() } : {}) };
}

/** The tracked session ids the world holds (the World section's list), or the service's when no world is built yet. */
async function trackedIds(ctx: DomainToolContext): Promise<string[]> {
  const world = await ctx.hub.world.current().catch(() => null);
  return world?.tracked ?? (await ctx.hub.tracked.list()).map((row) => row.sessionId);
}

export function trackedTools(ctx: DomainToolContext): ToolSet {
  if (!ctx.interactive) return {};
  const { deps, hub } = ctx;
  const row = (tracked: TrackedSession) => ({ trackedAt: tracked.trackedAt, trackedBy: tracked.trackedBy });
  return {
    track_session: define(
      "Track a session: it joins the tracked list the user sees beside the thread and the Tracked sessions section of the World. Sessions you start (create_session, setup_pr_reviews) are tracked already. Idempotent.",
      z.object({ sessionId }),
      async (input) => {
        const id = (await requireSession(deps, input.sessionId)).id;
        const result = await hub.tracked.track(id, "portal", trackContext(ctx));
        if (!result) throw new Error(`No session has id "${input.sessionId}".`);
        return { sessionId: id, tracked: true, ...row(result.session), ...(result.created ? {} : { note: "It was already tracked." }) };
      },
    ),
    untrack_session: define(
      "Stop tracking a session: it leaves the tracked list. Do it once its work is done and reported, or when it no longer matters; reason says why in a few words (it goes into the activity log).",
      z.object({ sessionId, reason: z.string().max(200).optional() }),
      async ({ reason, ...input }) => {
        const id = (await requireSession(deps, input.sessionId)).id;
        const untracked = await hub.tracked.untrack(id, "portal", trackContext(ctx, reason));
        return { sessionId: id, untracked, ...(untracked ? {} : { note: "It was not tracked." }) };
      },
    ),
    list_tracked_sessions: define(
      "The tracked sessions, oldest tracked first, each with its live state (activity, liveness and its line, when the user last prompted it) and when and by whom (user or portal) it was tracked. The World section's Tracked sessions shows the same list.",
      z.object({}),
      async () => {
        const [ids, rows, sessions] = await Promise.all([trackedIds(ctx), hub.tracked.list(), deps.sessions.list()]);
        const trackedById = new Map(rows.map((entry) => [entry.sessionId, entry]));
        const metaById = new Map(sessions.map((meta) => [meta.id, meta]));
        return {
          sessions: ids.flatMap((id) => {
            const meta = metaById.get(id);
            const tracked = trackedById.get(id);
            // A session deleted since the list was read is gone from both; nothing to show.
            if (!meta) return [];
            return [{ ...sessionRow(meta), trackedAt: tracked?.trackedAt ?? null, trackedBy: tracked?.trackedBy ?? null }];
          }),
        };
      },
    ),
  };
}
