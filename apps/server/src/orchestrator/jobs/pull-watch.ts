/**
 * PR monitors: "monitor #42 until it merges" is an intent whose check job carries a pull watch.
 * Each check asks GitHub for the PR's status and compares it with what the previous check saw
 * (kept in the job's payload); only the events the monitor reports make it fire, so the user hears
 * of state changes and nothing else. The first check only records the baseline. A merged or
 * closed PR fires one last time and ends the intent. No model is involved.
 */
import type { Intent, Job } from "@portal/contracts/jobs";
import type { PullStatus } from "../github-attention.ts";
import { MAIN_THREAD_ID } from "../types.ts";
import type { JobsCore } from "./core.ts";
import type { KindContext, KindResult } from "./kinds.ts";

/** What a monitor can report. `comments` (new reviews or comments) is off unless asked for. */
export const pullEvents = ["merged", "closed", "checks_failing", "checks_passing", "changes_requested", "approved", "conflicts", "comments"] as const;
export type PullEvent = (typeof pullEvents)[number];
export const DEFAULT_PULL_EVENTS: readonly PullEvent[] = ["merged", "closed", "checks_failing", "checks_passing", "changes_requested", "approved", "conflicts"];

/** The fields of a PR's status a monitor compares between checks. */
export type PullSnapshot = Pick<PullStatus, "state" | "draft" | "checks" | "reviewDecision" | "mergeable" | "headSha" | "reviews" | "comments" | "lastReview">;

/** The check job's `payload.pull`. */
export type PullWatch = {
  repo: string;
  number: number;
  url: string;
  events: PullEvent[];
  /** What the previous check saw; null before the first. */
  last: PullSnapshot | null;
};

/** One change worth telling: which event, and a line for the user. */
export type PullChange = { event: PullEvent; text: string };

export const DEFAULT_MONITOR_CHECK_MS = 5 * 60_000;

const eventSet = new Set<string>(pullEvents);

export function pullWatchOf(payload: Record<string, unknown>): PullWatch | null {
  const raw = payload.pull as Partial<PullWatch> | undefined;
  if (!raw || typeof raw !== "object" || typeof raw.repo !== "string" || typeof raw.number !== "number" || typeof raw.url !== "string") return null;
  const events = Array.isArray(raw.events) ? raw.events.filter((event): event is PullEvent => eventSet.has(event)) : [...DEFAULT_PULL_EVENTS];
  return { repo: raw.repo, number: raw.number, url: raw.url, events, last: raw.last && typeof raw.last === "object" ? raw.last : null };
}

export function snapshotOf(status: PullStatus): PullSnapshot {
  const { state, draft, checks, reviewDecision, mergeable, headSha, reviews, comments, lastReview } = status;
  return { state, draft, checks, reviewDecision, mergeable, headSha, reviews, comments, lastReview };
}

/**
 * What changed between two snapshots, as events, whether the monitor reports them or not. A new
 * review counts as approved or changes requested even when the overall decision stays the same
 * (a second reviewer), and as a comment when it is neither.
 */
export function pullChanges(before: PullSnapshot, after: PullSnapshot): PullChange[] {
  const changes: PullChange[] = [];
  if (after.state !== before.state) {
    if (after.state === "merged") changes.push({ event: "merged", text: "was merged" });
    else if (after.state === "closed") changes.push({ event: "closed", text: "was closed without merging" });
  }
  if (after.checks !== before.checks) {
    if (after.checks === "failing") changes.push({ event: "checks_failing", text: "checks are failing" });
    else if (after.checks === "passing" && before.checks === "failing") changes.push({ event: "checks_passing", text: "checks pass again" });
  }
  const newReview = after.lastReview && (!before.lastReview || after.lastReview.at > before.lastReview.at) ? after.lastReview : null;
  if (after.reviewDecision === "changes_requested" && before.reviewDecision !== "changes_requested") {
    changes.push({ event: "changes_requested", text: `changes were requested${newReview?.state === "changes_requested" ? ` by ${newReview.author}` : ""}` });
  } else if (newReview?.state === "changes_requested") {
    changes.push({ event: "changes_requested", text: `${newReview.author} requested changes` });
  }
  if (after.reviewDecision === "approved" && before.reviewDecision !== "approved") {
    changes.push({ event: "approved", text: `it was approved${newReview?.state === "approved" ? ` by ${newReview.author}` : ""}` });
  } else if (newReview?.state === "approved") {
    changes.push({ event: "approved", text: `${newReview.author} approved it` });
  }
  if (after.mergeable !== before.mergeable) {
    if (after.mergeable === "conflicting") changes.push({ event: "conflicts", text: "it has merge conflicts" });
    else if (after.mergeable === "mergeable" && before.mergeable === "conflicting") changes.push({ event: "conflicts", text: "the merge conflicts are resolved" });
  }
  const newComments = Math.max(0, after.comments - before.comments);
  const otherReviews = newReview && newReview.state !== "approved" && newReview.state !== "changes_requested" ? Math.max(1, after.reviews - before.reviews) : 0;
  if (newComments + otherReviews > 0) {
    const parts = [...(otherReviews ? [`${otherReviews} review${otherReviews === 1 ? "" : "s"}`] : []), ...(newComments ? [`${newComments} comment${newComments === 1 ? "" : "s"}`] : [])];
    changes.push({ event: "comments", text: `${parts.join(" and ")} new` });
  }
  return changes;
}

/** The PR's state in one line, for an item body. */
export function describeSnapshot(snapshot: PullSnapshot): string {
  const parts: string[] = [snapshot.state === "open" && snapshot.draft ? "draft" : snapshot.state];
  if (snapshot.state === "open") {
    if (snapshot.checks) parts.push(`checks ${snapshot.checks}`);
    parts.push(snapshot.reviewDecision === "approved" ? "approved" : snapshot.reviewDecision === "changes_requested" ? "changes requested" : "review pending");
    if (snapshot.mergeable === "conflicting") parts.push("conflicting");
  }
  return parts.join(", ");
}

export type PullCheckParts = {
  core: JobsCore;
  fire(id: string, what: { title: string; body: string; item?: boolean }, how: { actor: "system"; runId: string; touched?: Set<string> }): Promise<{ fired: boolean; itemId?: string | null }>;
  close(id: string, status: "done", how: { actor: "system"; runId: string; reason?: string }): Promise<unknown>;
};

/** One check of a PR monitor. */
export async function checkPull({ core, fire, close }: PullCheckParts, { job, run }: KindContext, intent: Intent, watch: PullWatch): Promise<KindResult> {
  const { hub } = core;
  const status = await hub.deps.github.pullStatus(watch.repo, watch.number);
  const now = snapshotOf(status);
  const name = `${watch.repo}#${watch.number}`;
  await remember(core, job, watch, now);
  await core.store.updateIntent(intent.id, { lastCheckedAt: hub.timers.now() });
  const ended = now.state !== "open";
  // The first look sets the baseline; a PR already merged or closed is news once.
  const changes = watch.last ? pullChanges(watch.last, now) : ended ? pullChanges({ ...now, state: "open" }, now) : [];
  const told = changes.filter((change) => watch.events.includes(change.event));
  const threadId = intent.threadId ?? MAIN_THREAD_ID;
  let fired = false;
  if (told.length) {
    const title = `${name} ${told.map((change) => change.text).join("; ")}`;
    const body = [`**${status.title || name}**`, ...told.map((change) => `- ${change.text[0].toUpperCase()}${change.text.slice(1)}`), "", `Now: ${describeSnapshot(now)}.`].join("\n");
    const touched = new Set<string>();
    const result = await fire(intent.id, { title, body }, { actor: "system", runId: run.id, touched });
    fired = result.fired;
    if (fired) await core.postToThread(threadId, `${title}.`, run, [...touched]);
  }
  if (ended) {
    await close(intent.id, "done", { actor: "system", runId: run.id, reason: `${name} was ${now.state}` });
    return { summary: `${name} was ${now.state}; the monitor is done.`, jobStatus: "done", result: { intentId: intent.id, fired, changes: told, status: now } };
  }
  return {
    summary: told.length ? `${name}: ${told.map((change) => change.text).join("; ")}` : watch.last ? `${name}: no change (${describeSnapshot(now)}).` : `${name}: watching from here (${describeSnapshot(now)}).`,
    result: { intentId: intent.id, fired, changes: told, ignored: changes.filter((change) => !told.includes(change)).map((change) => change.event), status: now },
  };
}

/** Keep what this check saw in the job's payload for the next one. */
async function remember(core: JobsCore, job: Job, watch: PullWatch, snapshot: PullSnapshot): Promise<void> {
  const latest = (await core.store.getJob(job.id)) ?? job;
  const pull = pullWatchOf(latest.payload) ?? watch;
  await core.store.updateJob(job.id, { payload: { ...latest.payload, pull: { ...pull, last: snapshot } } });
}
