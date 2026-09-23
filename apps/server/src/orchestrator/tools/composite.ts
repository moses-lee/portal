import { z } from "zod";
import type { Project } from "../../lib/types.ts";
import type { DomainToolContext } from "../hub.ts";
import { findProjectForRepo, httpError, repoOf, requireProject, startSession, worktreeProject } from "../ops.ts";
import type { PullRef } from "../types.ts";
import { type ToolContext, define, errorMessage } from "./context.ts";

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * The brief for reviewing someone else's PR when the orchestrator wrote none. The stored "review"
 * prompt is for the user's own PRs (it triages the comments they received), which is the wrong job
 * for a reviewer.
 */
export const REVIEWER_PROMPT = [
  "Review this pull request as a code reviewer. You are on its branch in a worktree.",
  "Read the PR description, then the whole diff against its base branch (git fetch, then git diff origin/<base>...HEAD), and the surrounding code wherever the diff depends on it.",
  "Report findings grouped as blocking, should fix, and nits, each with file:line and why it matters; then say briefly what you checked and what looks good.",
  "Do not change files, push, or comment on GitHub: this is a read-only review for the user.",
].join(" ");

/** Which brief a PR's review session gets: the orchestrator's own, the user's triage prompt for their own PR, or the reviewer's brief. */
export function reviewPromptFor({ given, author, login, stored }: { given?: string; author?: string; login: string | null; stored: string }): string {
  if (given?.trim()) return given.trim();
  if (author && login && author.toLowerCase() === login.toLowerCase()) return stored.trim();
  return REVIEWER_PROMPT;
}
/** How often the intent setup_pr_reviews creates checks whether the review sessions finished. */
export const REVIEW_CHECK_MS = 5 * 60_000;

export function compositeTools(ctx: ToolContext) {
  const { deps, settings } = ctx;
  // Turns build these tools over the domain context; a bare tool context (a test) has no jobs to watch with.
  const domain = "hub" in ctx ? (ctx as DomainToolContext) : null;

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
      "Review several pull requests of one repository at once: for each PR, check out its branch in a worktree, start a session there, and send a review prompt. Creates one intent that reports the findings when the sessions finish. Use this instead of doing the steps by hand. Write prompt yourself from what memory says about reviewing (the author's review style, the code-review task type, the repo's conventions), interpreted for these PRs rather than pasted; without one, the user's own PRs get their stored triage prompt and everyone else's get a reviewer's brief.",
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
        const [stored, login] = await Promise.all([settings.read().then((read) => read.gitActions.prompts.review), deps.github.login().catch(() => null)]);
        const sessions: { pr: number; sessionId: string; projectId: string; promptError?: string }[] = [];
        const pulls: PullRef[] = [];
        const errors: string[] = [];
        for (const number of numbers) {
          try {
            const pull = await deps.git.getPull(repoRoot, number);
            if (pull.fork) throw httpError(`comes from a fork; Portal cannot check it out.`, 409);
            const { project: target } = await worktreeProject(deps, { from: project, branch: pull.branch });
            const url = `${origin.url}/pull/${number}`;
            const reviewPrompt = reviewPromptFor({ given: prompt, author: pull.author, login, stored });
            const { sessionId, promptError } = await startSession(deps, { projectId: target.id, agentId, prompt: `${reviewPrompt}\n\nPR #${number}: ${url}` });
            sessions.push({ pr: number, sessionId, projectId: target.id, ...(promptError ? { promptError } : {}) });
            if (promptError) errors.push(`PR #${number}: the session started but the prompt failed: ${promptError}`);
            pulls.push({ repo: origin.repo, number, url });
          } catch (err) {
            errors.push(`PR #${number}: ${errorMessage(err)}`);
          }
        }
        if (sessions.length === 0 || !domain) return { sessions, intentId: null, errors };
        const sessionIds = sessions.map((entry) => entry.sessionId);
        const { intent } = await domain.hub.jobs.createIntent({
          text: `Review PRs ${sessions.map((entry) => entry.pr).join(", ")} on ${origin.repo}; tell me the findings when the review sessions finish`,
          trigger: `Every review session (${sessionIds.join(", ")}) has finished its turn: idle, not waiting for permission, with its review in the transcript.`,
          action: "Read each session's transcript and tell me the findings per PR (blocking issues first), with links to the PRs and sessions.",
          notes: [
            `Started ${sessions.length} review session(s): ${sessions.map((entry) => `#${entry.pr} -> ${entry.sessionId}`).join(", ")}.`,
            ...errors,
          ].join("\n"),
          scope: {
            sessionIds, projectIds: [...new Set([project.id, ...sessions.map((entry) => entry.projectId)])], pulls, repos: [origin.repo], taskTypes: ["code-review"],
          },
          fireBudget: 1,
          check: { type: "every", everyMs: REVIEW_CHECK_MS },
        }, { actor: "agent", runId: domain.turn.runId, threadId: domain.turn.threadId });
        return { sessions, intentId: intent.id, errors };
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
