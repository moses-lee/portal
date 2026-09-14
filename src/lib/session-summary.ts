import { displayPath, readGitInfo } from "./git-info";
import type { SessionMeta, SessionSummary } from "./types";

/** Attach the session directory's display form and current branch for the browser. */
export async function summarizeSession(meta: SessionMeta): Promise<SessionSummary> {
  const { id, agentId, agentName, cwd, createdAt, busy } = meta;
  return { id, agentId, agentName, cwd, createdAt, busy, displayCwd: displayPath(cwd), git: await readGitInfo(cwd) };
}
