/**
 * Review worktrees go once the findings are read. `setup_pr_reviews` checks each PR's branch out
 * into a worktree of its own (recorded as `worktreeCreated` on the goal's review watch). When the
 * user settles that PR's `review_findings` item (resolves or dismisses it), Portal removes the
 * worktree, its project entry, and the local branch when the branch is exactly on origin, without
 * an approval: Portal made the worktree for itself, the review only read, and the checks below
 * make sure nothing would be lost. A worktree still used by a running session, one with uncommitted
 * changes, or one git refuses to remove is left in place with a Needs-you item that carries the
 * (approval-gated) Remove worktree action instead. The review session keeps its transcript.
 */
import { randomUUID } from "node:crypto";
import type { Item, ItemAction } from "@portal/contracts/orchestrator";
import type { OrchestratorHub } from "../hub.ts";
import { removeProject } from "../ops.ts";
import { MAIN_THREAD_ID } from "../types.ts";
import { reviewWatchOf } from "./review-watch.ts";

const fingerprintFor = (projectId: string) => `review_worktree:${projectId}`;

/** Leave (or refresh) the Needs-you item that hands the removal to the user. */
async function leaveToUser(hub: OrchestratorHub, item: Item, projectId: string, name: string, why: string): Promise<void> {
  const fingerprint = fingerprintFor(projectId);
  const actions: ItemAction[] = [
    { type: "remove_worktree", projectId, label: "Remove worktree" },
    ...(item.links.sessionId ? [{ type: "open_session" as const, sessionId: item.links.sessionId, label: "Open review" }] : []),
  ];
  const title = `The review worktree for ${name} was kept`;
  const body = `${why} Remove it from here when you are done with it; the review session keeps its transcript.`;
  const links = { projectId, ...(item.links.sessionId ? { sessionId: item.links.sessionId } : {}), ...(item.links.pull ? { pull: item.links.pull } : {}), ...(item.links.intentId ? { intentId: item.links.intentId } : {}) };
  const existing = await hub.store.findItemByFingerprint(fingerprint);
  if (existing && existing.status === "dismissed") return;
  if (existing) await hub.store.updateItem(existing.id, { kind: "worktree_dirty", title, body, actions, links, status: "open" });
  else await hub.store.createItem({ kind: "worktree_dirty", title, body, actions, links, fingerprint });
  hub.emit({ type: "items", items: await hub.store.listItems() });
  void hub.activity.log({ actor: "system", kind: "review.worktree_kept", summary: `Kept the review worktree for ${name}: ${why}`, refs: { projectId, itemId: item.id } });
}

/** One line in the thread the goal reported to (its side thread, else the main one). */
async function tell(hub: OrchestratorHub, item: Item, text: string): Promise<void> {
  const wanted = item.links.threadId ?? MAIN_THREAD_ID;
  const thread = await hub.store.getThread(wanted);
  const threadId = thread && thread.status === "active" ? wanted : MAIN_THREAD_ID;
  await hub.store.appendMessages([{ id: randomUUID(), role: "assistant", parts: [{ type: "text", text }], metadata: { at: hub.timers.now() } }], threadId);
  hub.emit({ type: "messages", threadId });
}

/**
 * The user settled a findings item: remove the review worktree it belongs to when that is safe,
 * else leave it to them. Anything but a `review_findings` item, or a worktree the review did not
 * create, is left alone. Never throws: the item change that triggered it has already happened.
 */
export async function settleReviewWorktree(hub: OrchestratorHub, item: Item): Promise<void> {
  if (item.kind !== "review_findings") return;
  const { projectId, intentId, sessionId, pull } = item.links;
  if (!projectId || !intentId) return;
  const name = pull ? `${pull.repo}#${pull.number}` : item.title;
  try {
    const watch = (await hub.jobs.listJobs({ kind: ["intent_check"], intentId })).map((job) => reviewWatchOf(job.payload)).find((entry) => entry !== null) ?? null;
    const session = watch?.sessions.find((entry) => entry.projectId === projectId && (!sessionId || entry.sessionId === sessionId));
    if (!session?.worktreeCreated) return;
    const project = await hub.deps.projects.get(projectId);
    if (!project?.worktree) return;
    // Another PR reviewed in the same worktree still has open findings: it goes when those are read.
    const others = (await hub.store.listItems()).filter((other) => other.id !== item.id && other.kind === "review_findings"
      && other.links.projectId === projectId && (other.status === "open" || other.status === "snoozed"));
    if (others.length) return;
    const busy = (await hub.deps.sessions.list()).filter((entry) => entry.projectId === projectId && entry.busy);
    if (busy.length) {
      await leaveToUser(hub, item, projectId, name, `A session is still working in it.`);
      return;
    }
    const parent = await hub.deps.projects.get(project.worktree.parentId);
    const repoRoot = parent ? await hub.deps.git.repoRootOf(parent.path).catch(() => null) : null;
    const state = repoRoot
      ? await hub.deps.git.worktreeState({ repoRoot, path: project.path, branch: project.worktree.branch, defaultBranch: null }).catch(() => null)
      : null;
    if (state?.dirty) {
      await leaveToUser(hub, item, projectId, name, `It has uncommitted changes.`);
      return;
    }
    let branchDeleted = false;
    try {
      ({ branchDeleted } = await removeProject(hub.deps, { id: projectId, deleteWorktree: true, deleteBranch: "pushed" }));
    } catch (err) {
      await leaveToUser(hub, item, projectId, name, `Git refused to remove it: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const branch = project.worktree.branch;
    const text = branchDeleted
      ? `Removed the review worktree for ${name} and its local branch ${branch}, now that its findings are read.`
      : `Removed the review worktree for ${name}, now that its findings are read; the local branch ${branch} stays (it is not exactly on origin).`;
    void hub.activity.log({ actor: "system", kind: "review.worktree_removed", summary: text, refs: { projectId, itemId: item.id, ...(sessionId ? { sessionId } : {}), intentId }, detail: { branch, branchDeleted } });
    await tell(hub, item, text);
  } catch (err) {
    console.error(`Could not clean up the review worktree for ${name}:`, err);
  }
}
