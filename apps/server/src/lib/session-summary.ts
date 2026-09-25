import { stat } from "node:fs/promises";
import { displayPath, readGitInfo } from "./git-info.ts";
import type { Project, SessionMeta, SessionSummary } from "./types.ts";

/** Attach the session directory's display form, current branch, and owning project for the browser. */
export async function summarizeSession(meta: SessionMeta, project: Project | null): Promise<SessionSummary> {
  const { id, agentId, agentName, cwd, projectId, createdAt, lastActiveAt, title, busy, awaitingPermission, link, state, liveness } = meta;
  const cwdMissing = await stat(cwd).then(() => false, () => true);
  // readGitInfo walks up to parent directories, so skip it once the folder itself is gone.
  const git = cwdMissing ? null : await readGitInfo(cwd);
  return {
    id, agentId, agentName, cwd, projectId, createdAt, lastActiveAt, title, busy, awaitingPermission, link, state, liveness,
    displayCwd: displayPath(cwd), git,
    project: project ? { id: project.id, name: project.name } : null,
    cwdMissing,
  };
}
