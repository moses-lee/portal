/**
 * Deleting a session for good, the same way from every caller (the HTTP routes and the
 * orchestrator's `delete_session`): the runtime drops the session and its log and fires the list's
 * `deleted` event, its Portal terminals close, and a removed project left with no sessions is
 * forgotten, since a Removed row only exists to hold conversations.
 */
import type { AppContext } from "../context.ts";

export type SessionDeletion = Pick<AppContext, "sessions" | "projects" | "terminals">;

/** Resolves false for an unknown session. Rejects only when the runtime could not delete it. */
export async function deleteSessionFully(ctx: SessionDeletion, id: string): Promise<boolean> {
  await Promise.all([ctx.projects.ready, ctx.sessions.ready]);
  const projectId = ctx.sessions.getSession(id)?.projectId;
  if (!(await ctx.sessions.deleteSession(id))) return false;
  ctx.terminals.closeSession(id);
  if (projectId) await forgetIfEmpty(ctx, projectId);
  return true;
}

/** Drop the removed record of `projectId` once no session points at it any more. */
async function forgetIfEmpty(ctx: SessionDeletion, projectId: string): Promise<void> {
  if (!ctx.projects.getRemoved(projectId)) return;
  if (ctx.sessions.listSessions().some((session) => session.projectId === projectId)) return;
  // The session is already gone; a record that failed to go only lingers as an empty Removed row.
  await ctx.projects.forgetRemoved(projectId).catch(() => {});
}

/**
 * Delete every session whose project is no longer listed (removed projects, and conversations whose
 * project left no record), then every removed record left with no sessions. Answers how many sessions went.
 */
export async function deleteRemovedSessions(ctx: SessionDeletion): Promise<number> {
  await Promise.all([ctx.projects.ready, ctx.sessions.ready]);
  let deleted = 0;
  for (const session of ctx.sessions.listSessions()) {
    if (ctx.projects.get(session.projectId)) continue;
    if (await deleteSessionFully(ctx, session.id)) deleted++;
  }
  // Only records left empty: one removed meanwhile, whose sessions were not in the list above, stays.
  for (const record of ctx.projects.listRemoved()) {
    if (ctx.sessions.listSessions().some((session) => session.projectId === record.id)) continue;
    await ctx.projects.forgetRemoved(record.id);
  }
  return deleted;
}
