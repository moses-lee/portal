import { z } from "zod";
import type { Project } from "../../lib/types.ts";
import type { DomainToolContext } from "../hub.ts";
import { findProjectForRepo, httpError, repoOf, requireProject, startSession, worktreeProject } from "../ops.ts";
import { REVIEW_CHECK_MS, type ReviewSession } from "../jobs/review-watch.ts";
import type { OrchestratorHub } from "../hub.ts";
import type { MemoryRecord } from "@portal/contracts/memory";
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
/** Longest record body quoted back when setup_pr_reviews asks for a brief written from memory. */
const GUIDANCE_BODY_CHARS = 400;

export type ReviewGuidance = { id: string; about: string; key: string; body: string };

/**
 * What memory says about reviewing these PRs: the authors' records about reviews (or their
 * procedures and preferences), everything about the code-review task type, and the repo's
 * conventions and procedures.
 */
export async function reviewGuidance(hub: OrchestratorHub, repo: string, authors: string[]): Promise<ReviewGuidance[]> {
  const found = await hub.memory.recordsFor([
    ...authors.map((login) => ({ type: "person" as const, key: login })), { type: "task_type", key: "code-review" }, { type: "repo", key: repo },
  ]);
  const wanted = (type: string, record: MemoryRecord) => type === "task_type"
    || (type === "person" && (/review/i.test(`${record.key} ${record.body}`) || ["procedure", "preference", "feedback"].includes(record.type)))
    || (type === "repo" && ["convention", "procedure"].includes(record.type));
  return found.flatMap(({ entity, records }) => records.filter((record) => wanted(entity.type, record)).map((record) => ({
    id: record.id, about: `${entity.type} ${entity.key}`, key: record.key,
    body: record.body.length > GUIDANCE_BODY_CHARS ? `${record.body.slice(0, GUIDANCE_BODY_CHARS - 1)}…` : record.body,
  })));
}

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
      "Review several pull requests of one repository at once: for each PR, check out its branch in a worktree, start a session there, and send a review prompt. Creates one goal that reports each PR's findings as a Needs-you item when the sessions finish. Use this instead of doing the steps by hand. Write prompt yourself from what memory says about reviewing (the author's review style, the code-review task type, the repo's conventions), interpreted for these PRs rather than pasted, and pass the ids of those records as memoryIds; when memory has such guidance and no prompt is given, the call is refused with the guidance to write from. Without guidance, the user's own PRs get their stored triage prompt and everyone else's get a reviewer's brief.",
      z.object({
        repo: z.string().regex(REPO_PATTERN, "Expected owner/name.").optional(),
        projectId: z.string().optional(),
        numbers: z.array(z.number().int().positive()).min(1).max(10),
        prompt: z.string().optional(),
        memoryIds: z.array(z.string()).max(20).optional().describe("Ids of the memory records the prompt was written from."),
        agentId: z.string().optional(),
      }),
      async ({ repo, projectId, numbers, prompt, memoryIds = [], agentId }) => {
        const project = await resolveProject({ projectId, repo });
        const origin = await repoOf(deps, project);
        if (!origin) throw httpError(`${project.name} has no GitHub origin.`, 409);
        const repoRoot = await deps.git.repoRootOf(project.path);
        const [stored, login] = await Promise.all([settings.read().then((read) => read.gitActions.prompts.review), deps.github.login().catch(() => null)]);
        const fetched = new Map<number, Awaited<ReturnType<typeof deps.git.getPull>> | Error>();
        for (const number of numbers) fetched.set(number, await deps.git.getPull(repoRoot, number).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err)))));
        // A brief for someone else's PR is written from memory when memory has guidance: refuse until the model wrote one.
        const others = [...new Set([...fetched.values()].flatMap((pull) => (pull instanceof Error || !pull.author || pull.author.toLowerCase() === login?.toLowerCase() ? [] : [pull.author])))];
        if (!prompt?.trim() && others.length && domain) {
          const guidance = await reviewGuidance(domain.hub, origin.repo, others);
          if (guidance.length) {
            throw httpError([
              "Memory has guidance for reviewing these PRs. Write prompt from it, interpreted for these PRs rather than pasted, and call setup_pr_reviews again with prompt and memoryIds:",
              ...guidance.map((entry) => `- ${entry.id} (${entry.about} · ${entry.key}): ${entry.body}`),
            ].join("\n"), 409);
          }
        }
        const sessions: (ReviewSession & { promptError?: string })[] = [];
        const pulls: PullRef[] = [];
        const errors: string[] = [];
        for (const number of numbers) {
          try {
            const pull = fetched.get(number)!;
            if (pull instanceof Error) throw pull;
            if (pull.fork) throw httpError(`comes from a fork; Portal cannot check it out.`, 409);
            const { project: target } = await worktreeProject(deps, { from: project, branch: pull.branch });
            const url = `${origin.url}/pull/${number}`;
            const reviewPrompt = reviewPromptFor({ given: prompt, author: pull.author, login, stored });
            const { sessionId, promptError } = await startSession(deps, { projectId: target.id, agentId, prompt: `${reviewPrompt}\n\nPR #${number}: ${url}` });
            sessions.push({
              pr: number, url, sessionId, projectId: target.id, title: pull.title, ...(pull.author ? { author: pull.author } : {}), ...(promptError ? { promptError } : {}),
            });
            if (promptError) errors.push(`PR #${number}: the session started but the prompt failed: ${promptError}`);
            pulls.push({ repo: origin.repo, number, url });
          } catch (err) {
            errors.push(`PR #${number}: ${errorMessage(err)}`);
          }
        }
        if (sessions.length === 0 || !domain) return { sessions, intentId: null, errors };
        const sessionIds = sessions.map((entry) => entry.sessionId);
        const known = memoryIds.filter((id) => /^m[\w-]+$/.test(id));
        const { intent } = await domain.hub.jobs.createIntent({
          text: `Review PRs ${sessions.map((entry) => entry.pr).join(", ")} on ${origin.repo}; tell me the findings when the review sessions finish`,
          trigger: `Every review session (${sessionIds.join(", ")}) has finished its turn.`,
          action: "Summarize each session's review into a Needs-you item with the findings per PR (blocking first) and links to the PR and session.",
          notes: [
            `Started ${sessions.length} review session(s): ${sessions.map((entry) => `#${entry.pr} -> ${entry.sessionId}`).join(", ")}.`,
            ...(known.length ? [`Brief written from memory: ${known.join(", ")}.`] : []),
            ...errors,
          ].join("\n"),
          scope: {
            sessionIds, projectIds: [...new Set([project.id, ...sessions.map((entry) => entry.projectId)])], pulls, repos: [origin.repo], taskTypes: ["code-review"],
          },
          fireBudget: 1,
          check: { type: "every", everyMs: REVIEW_CHECK_MS },
          checkPayload: {
            review: {
              repo: origin.repo, sessions: sessions.map(({ promptError: _promptError, ...entry }) => entry), ...(known.length ? { memoryIds: known } : {}),
            },
          },
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
