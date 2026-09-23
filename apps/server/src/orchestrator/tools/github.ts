import { z } from "zod";
import { displayPath } from "../../lib/git-info.ts";
import type { GithubSummary } from "../../lib/types.ts";
import { type LocalProject, attachLocalProjects, attentionReasons, pullKey } from "../github-attention.ts";
import { requireProject } from "../ops.ts";
import { type ToolContext, capped, define } from "./context.ts";

const projectId = z.string().min(1);

/** The GitHub panel's summary without the commit log, with check names only for what fails. */
function compactStatus(summary: GithubSummary) {
  const { pull, conflicts } = summary;
  return {
    branch: summary.branch, detached: summary.detached, defaultBranch: summary.defaultBranch, upstream: summary.upstream,
    ahead: summary.ahead, behind: summary.behind, fetchedAt: summary.fetchedAt, fetchError: summary.fetchError, repoUrl: summary.repoUrl,
    pull: pull ? {
      number: pull.number, title: pull.title, url: pull.url, state: pull.state, draft: pull.draft, baseBranch: pull.baseBranch,
      review: pull.reviewDecision, unresolvedThreads: pull.unresolvedThreads, comments: pull.comments, mergeable: pull.mergeable,
      checks: pull.checks ? {
        state: pull.checks.state, passing: pull.checks.passing, failing: pull.checks.failing, pending: pull.checks.pending,
        failingNames: pull.checks.checks.filter((check) => check.state === "failing").map((check) => check.name).slice(0, 10),
      } : null,
    } : null,
    pullError: summary.pullError,
    conflicts: conflicts?.status === "conflicts"
      ? { status: conflicts.status, base: conflicts.base, files: conflicts.files.slice(0, 20), truncated: conflicts.files.length > 20 }
      : conflicts,
  };
}

export function githubTools({ deps }: ToolContext) {
  const repoRootFor = async (id: string) => deps.git.repoRootOf((await requireProject(deps, id)).path);
  return {
    github_identity: define("The GitHub login gh is signed in as.", z.object({}), async () => ({ login: await deps.github.login() })),
    list_attention_pulls: define(
      "Open PRs across GitHub that concern the user (authored, or their review requested), newest first, with why each needs attention and the Portal project when the repo is local.",
      z.object({}),
      async () => {
        const { pulls, error } = await deps.github.searchAttentionPulls();
        if (error) return { error };
        const locals: LocalProject[] = await Promise.all((await deps.projects.list()).map(async (project) => ({
          id: project.id, path: project.path, remoteUrl: await deps.git.originUrl(project.path).catch(() => null), worktree: project.worktree,
        })));
        const { rows, truncated } = capped(attachLocalProjects(pulls, locals));
        return {
          pulls: rows.map((pull) => ({
            key: pullKey(pull), title: pull.title, url: pull.url, author: pull.author, roles: pull.roles, draft: pull.draft,
            checks: pull.checks, review: pull.reviewDecision, mergeable: pull.mergeable, updatedAt: pull.updatedAt,
            reasons: attentionReasons(pull), projectId: pull.localProjectId, worktreeProjectId: pull.worktreeProjectId,
          })),
          truncated,
        };
      },
    ),
    list_pulls: define(
      "Open pull requests of a project's repository, newest first (number, title, head branch, fork flag).",
      z.object({ projectId }),
      async ({ projectId }) => {
        const { pulls, pullsError } = await deps.git.listPulls(await repoRootFor(projectId));
        if (!pulls) return { error: pullsError ?? "gh could not list pull requests." };
        const { rows, truncated } = capped(pulls);
        return { pulls: rows, truncated };
      },
    ),
    get_pull: define(
      "One pull request of a project's repository by number, in any state.",
      z.object({ projectId, number: z.number().int().positive() }),
      async ({ projectId, number }) => deps.git.getPull(await repoRootFor(projectId), number),
    ),
    get_github_status: define(
      "A project's GitHub state: branch, ahead/behind, its PR with check counts and review state, conflicting files. fetch runs git fetch first.",
      z.object({ projectId, fetch: z.boolean().optional() }),
      async ({ projectId, fetch }) => compactStatus(await deps.git.githubSummary((await requireProject(deps, projectId)).path, { fetch: fetch === true })),
    ),
    list_branches: define(
      "Branches of a project's repository (local and origin, except the default), newest commit first, with where each is checked out.",
      z.object({ projectId }),
      async ({ projectId }) => {
        const { defaultBranch, branches } = await deps.git.listBranches(await repoRootFor(projectId));
        const { rows, truncated } = capped(branches);
        return {
          defaultBranch,
          branches: rows.map((branch) => ({
            name: branch.name, local: branch.local, remote: branch.remote, committedAt: branch.committedAt,
            checkedOutAt: branch.worktreePath ? displayPath(branch.worktreePath) : null,
          })),
          truncated,
        };
      },
    ),
    fetch_repo: define(
      "git fetch origin --prune for a project's repository.",
      z.object({ projectId }),
      async ({ projectId }) => deps.git.fetchRepo(await repoRootFor(projectId)),
    ),
    pull_fast_forward: define(
      "git pull --ff-only in a project's folder, then its refreshed GitHub status. Fails when the branch diverged or the tree has changes.",
      z.object({ projectId }),
      async ({ projectId }) => compactStatus(await deps.git.pullFastForward((await requireProject(deps, projectId)).path)),
    ),
  };
}
