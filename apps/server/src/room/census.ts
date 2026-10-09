/**
 * The room's census (docs/PALACE.md, Census service): the counts behind the accumulated objects,
 * with high-water marks so they never go down, and the milestones they reached.
 *
 * Phase 4: this is a stub. It counts the sessions the server lists now and nothing else: no
 * high-water marks in the `room` settings row, no `since`, no milestones, no `room.expanded`
 * Activity entries. Phase 4 replaces it with the full census over the sessions, memory, intents,
 * grants, and activity stores, cached 60 seconds.
 */
import type { RoomCensus, RoomMilestone } from "@portal/contracts/room";
import type { AppContext } from "../context.ts";

export interface RoomCensusService {
  read(): Promise<RoomCensus>;
  /** The milestones reached so far, oldest first. */
  milestones(): Promise<RoomMilestone[]>;
}

export function createRoomCensus(ctx: Pick<AppContext, "sessions">): RoomCensusService {
  return {
    async read() {
      await ctx.sessions.ready;
      // Phase 4: a high-water mark (a purge must never lower it) and the rest of the counts.
      return {
        sessionsEver: ctx.sessions.listSessions().length,
        memoryActive: 0,
        memoryInbox: 0,
        watches: { active: 0, finished: 0, fires: 0, ever: 0 },
        grants: 0,
        activityLastHour: 0,
        since: null,
      };
    },
    // Phase 4: milestones from `milestonesReached(census)` against the stored set.
    milestones: async () => [],
  };
}
