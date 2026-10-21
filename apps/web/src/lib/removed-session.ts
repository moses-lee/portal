import type { SessionSummary } from "./types.ts";

/** A retained conversation whose owning project has been removed. Missing metadata is unknown. */
export function isRemovedSession(session: Pick<SessionSummary, "project"> | undefined): boolean {
  return session?.project === null;
}
