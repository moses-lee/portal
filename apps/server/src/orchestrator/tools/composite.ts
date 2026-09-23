import { z } from "zod";
import type { Project } from "../../lib/types.ts";
import { findProjectForRepo, httpError, repoOf, requireProject, startSession, worktreeProject } from "../ops.ts";
import type { PullRef } from "../types.ts";
import { type ToolContext, define, errorMessage } from "./context.ts";

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function compositeTools(ctx: ToolContext) {
  const { deps, store, settings } = ctx;

  /** The project to work from: by id, by GitHub repo, or a fresh clone when Portal lacks the repo. */
  async function resolveProject({ projectId, repo }: { projectId?: string; repo?: string }): Promise<Project> {
    if (projectId) return requireProject(deps, projectId);
    if (!repo) throw httpError("Give a projectId or a repo (owner/name).", 400);
    const known = await findProjectForRepo(deps, repo);
    if (known) return known;
    const dir = await deps.github.cloneRepo(repo);
    return (await deps.projects.findByPath(dir)) ?? deps.projects.add({ path: dir });
  }

  return {
    setup_pr_reviews: define(
      "Review several pull requests of one repository at once: for each PR, check out its branch in a worktree, start a session there, and send the review prompt (the stored one unless prompt is given). Creates one watch over the sessions. Use this instead of doing the steps by hand.",
      z.object({
        repo: z.string().regex(REPO_PATTERN, "Expected owner/name.").optional(),
        projectId: z.string().optional(),
        numbers: z.array(z.number().int().positive()).min(1).max(10),
        prompt: z.string().optional(),
        agentId: z.string().optional(),
      }),
      async ({ repo, projectId, numbers, prompt, agentId }) => {
        const project = await resolveProject({ projectId, repo });
        const origin = await repoOf(deps, project);
        if (!origin) throw httpError(`${project.name} has no GitHub origin.`, 409);
        const repoRoot = await deps.git.repoRootOf(project.path);
        const reviewPrompt = (prompt ?? (await settings.read()).gitActions.prompts.review).trim();
        const sessions: { pr: number; sessionId: string; projectId: string; promptError?: string }[] = [];
        const pulls: PullRef[] = [];
        const errors: string[] = [];
        for (const number of numbers) {
          try {
            const pull = await deps.git.getPull(repoRoot, number);
            if (pull.fork) throw httpError(`comes from a fork; Portal cannot check it out.`, 409);
            const { project: target } = await worktreeProject(deps, { from: project, branch: pull.branch });
            const url = `${origin.url}/pull/${number}`;
            const { sessionId, promptError } = await startSession(deps, { projectId: target.id, agentId, prompt: `${reviewPrompt}\n\nPR #${number}: ${url}` });
            sessions.push({ pr: number, sessionId, projectId: target.id, ...(promptError ? { promptError } : {}) });
            if (promptError) errors.push(`PR #${number}: the session started but the prompt failed: ${promptError}`);
            pulls.push({ repo: origin.repo, number, url });
          } catch (err) {
            errors.push(`PR #${number}: ${errorMessage(err)}`);
          }
        }
        if (sessions.length === 0) return { sessions, watchId: null, errors };
        const watch = await store.createWatch({
          intent: `Review PRs ${numbers.join(", ")} on ${origin.repo}`,
          notes: [
            `Started ${sessions.length} review session(s): ${sessions.map((entry) => `#${entry.pr} -> ${entry.sessionId}`).join(", ")}.`,
            ...errors,
            "Next: read each session's transcript once it is idle and summarise the findings for the user.",
          ].join("\n"),
          links: { sessionIds: sessions.map((entry) => entry.sessionId), projectIds: [...new Set([project.id, ...sessions.map((entry) => entry.projectId)])], pulls },
        });
        return { sessions, watchId: watch.id, errors };
      },
    ),
    get_settings: define(
      "The user's stored PR prompts (checks, conflicts, review) and the orchestrator's model and interval settings. Keys are reported as present or absent only.",
      z.object({}),
      async () => {
        const { gitActions, orchestrator } = await settings.read();
        return { prompts: gitActions.prompts, orchestrator };
      },
    ),
  };
}
