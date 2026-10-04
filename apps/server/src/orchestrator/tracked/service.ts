/**
 * Tracked sessions: the explicit set of sessions the user and Portal keep an eye on, shared by the
 * right sidebar and the agent. Every track and untrack goes through here, so each one is logged to
 * the activity view (`session.tracked`, `session.untracked`) and the whole list is pushed to the page
 * (`{ type: "tracked", sessions }`). The routes record `trackedBy: "user"`; the orchestrator's tools
 * and the sessions it starts record `"portal"`.
 *
 * A deleted session loses its row through the foreign key's cascade; the service hears of the
 * delete through `deps.sessions.onDeleted` and pushes the list again so open tabs drop it. That is
 * not logged: whoever deleted the session logs the delete (and the agent untracks first).
 */
import type { ActivityActor, ActivityRefs } from "@portal/contracts/activity";
import type { TrackedSession } from "@portal/contracts/orchestrator";
import type { OrchestratorHub } from "../hub.ts";
import type { TrackedBy, TrackedStore } from "./store.ts";

/** Where a track or untrack came from, for its activity entry. */
export type TrackContext = {
  /** Why, in a few words (the agent's reason for untracking); kept in the entry's detail. */
  reason?: string;
  runId?: string;
  threadId?: string;
  /** Who the activity entry names; by default the user for `trackedBy: "user"`, else the agent (the sweep says `system`). */
  actor?: ActivityActor;
};

export interface TrackedService {
  /** Oldest first. */
  list(): Promise<TrackedSession[]>;
  isTracked(sessionId: string): Promise<boolean>;
  /**
   * Track a session (idempotent: an already tracked one keeps its row, `created: false`, and nothing
   * is logged or pushed). Null when no such session exists.
   */
  track(sessionId: string, by: TrackedBy, context?: TrackContext): Promise<{ session: TrackedSession; created: boolean } | null>;
  /** Untrack a session; false (nothing logged or pushed) when it was not tracked. */
  untrack(sessionId: string, by: TrackedBy, context?: TrackContext): Promise<boolean>;
  /** Stop listening for deleted sessions. */
  dispose(): void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createTrackedService(hub: OrchestratorHub, store: TrackedStore): TrackedService {
  // Pushes go out one after the other, each reading the list after the change before it, so a slow
  // read can never land a stale list after a newer one.
  let pushing: Promise<void> = Promise.resolve();
  function push(): Promise<void> {
    pushing = pushing.then(async () => {
      try {
        const sessions = await store.list();
        hub.emit({ type: "tracked", sessions });
        // The world's tracked slice follows at once, so the prompt and list_tracked_sessions agree with the page.
        hub.world?.trackedChanged?.(sessions.map((row) => row.sessionId));
      } catch (err) {
        console.error(`Could not push the tracked sessions: ${errorMessage(err)}`);
      }
    });
    return pushing;
  }

  /** The session's name for the log (its title, else its agent and short id) and its project. */
  async function describe(sessionId: string): Promise<{ name: string; projectId?: string }> {
    const session = await hub.deps.sessions.get(sessionId).catch(() => null);
    if (!session) return { name: `session ${sessionId.slice(0, 8)}` };
    return { name: session.title?.trim() || `${session.agentName} session ${sessionId.slice(0, 8)}`, projectId: session.projectId };
  }

  async function log(kind: "session.tracked" | "session.untracked", sessionId: string, by: TrackedBy, context: TrackContext) {
    const { name, projectId } = await describe(sessionId);
    const reason = context.reason?.trim() || undefined;
    const verb = kind === "session.tracked" ? "Tracked" : "Untracked";
    const refs: ActivityRefs = {
      sessionId, ...(projectId ? { projectId } : {}), ...(context.runId ? { runId: context.runId } : {}),
      ...(context.threadId ? { threadId: context.threadId } : {}),
    };
    await hub.activity.log({
      actor: context.actor ?? (by === "user" ? "user" : "agent"), kind, summary: `${verb} "${name}"${reason ? `: ${reason}` : ""}`,
      refs, detail: { trackedBy: by, ...(reason ? { reason } : {}) },
    });
  }

  const unsubscribe = hub.deps.sessions.onDeleted?.((sessionId) => {
    // The cascade removes the row as the session's own row goes, which may be a moment later.
    void store.untrack(sessionId)
      .catch((err: unknown) => console.error(`Could not untrack deleted session ${sessionId}: ${errorMessage(err)}`))
      .then(push);
  }) ?? (() => {});

  return {
    list: () => store.list(),
    isTracked: (sessionId) => store.isTracked(sessionId),
    async track(sessionId, by, context = {}) {
      const result = await store.track(sessionId, by, hub.timers.now());
      // The runtime announces a delete before the session's row goes: a track landing in between
      // inserts a row the cascade would drop later without a push. Recheck and take it back.
      if (result?.created && !(await hub.deps.sessions.get(sessionId).catch(() => null))) {
        await store.untrack(sessionId);
        return null;
      }
      if (result?.created) {
        await log("session.tracked", sessionId, by, context);
        await push();
      }
      return result;
    },
    async untrack(sessionId, by, context = {}) {
      const removed = await store.untrack(sessionId);
      if (removed) {
        await log("session.untracked", sessionId, by, context);
        await push();
      }
      return removed;
    },
    dispose: unsubscribe,
  };
}
