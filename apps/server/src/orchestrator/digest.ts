/**
 * The deterministic half of a tick: read the world into a `TickSnapshot`, diff it against the
 * previous one, and hand the model only what changed. No model call happens here, so the tick
 * costs nothing when nothing moved and every rule below is unit-testable.
 */
import { agentActivity } from "@portal/shared/agent-activity";
import type { PortalEvent, Project, SessionMeta, WorktreeMeta } from "../lib/types.ts";
import type { AttentionSearch, OrchestratorDeps } from "./deps.ts";
import { type LocalProject, attachLocalProjects, attentionReasons, pullKey } from "./github-attention.ts";
import type { DigestChange, Item, ItemKind, ItemLinks, OrchestratorStore, PullAttention, TickDigest, TickSnapshot } from "./types.ts";

/** A dirty worktree is only worth mentioning once no session has touched it for this long. */
export const DIRTY_IDLE_MS = 24 * 60 * 60 * 1000;
/** Pull requests untouched for this long are left out of attention searches unless asked for: a conflict from last month is not news. */
export const STALE_PULL_MS = 14 * 24 * 60 * 60 * 1000;
/** Rows of the per-repo review list before it says "+N more". */
export const REVIEW_LIST_ROWS = 15;
const WORKTREE_CONCURRENCY = 4;

const sessionKinds: ItemKind[] = ["session_finished", "session_stopped", "session_waiting", "session_offline"];
/** Events read to learn how a session's last turn ended; the end is the turn's last event. */
const TURN_END_WINDOW = 20;
/** The kinds a PR the user authored can warrant, most severe first; the item takes the first one that applies. */
const authoredKinds: ItemKind[] = ["pr_changes_requested", "pr_checks_failing", "pr_conflicts"];
const worktreeKinds: ItemKind[] = ["worktree_merged", "worktree_dirty"];

const authoredReasonText: Record<string, string> = {
  pr_changes_requested: "changes requested",
  pr_checks_failing: "checks failing",
  pr_conflicts: "merge conflicts",
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await fn(next);
  }));
}

// ---------------------------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------------------------

/** Origin URL per project path, remembered for the process: a project's remote all but never changes. */
const originUrls = new Map<string, Promise<string | null>>();

/** Forget cached origin URLs; for tests. */
export function resetDigestCaches() {
  originUrls.clear();
}

function originUrl(deps: OrchestratorDeps, dir: string): Promise<string | null> {
  let cached = originUrls.get(dir);
  if (!cached) {
    cached = deps.git.originUrl(dir).catch(() => null);
    originUrls.set(dir, cached);
  }
  return cached;
}

/**
 * A session's activity for the snapshot. A session that is merely offline after a restart (no
 * error recorded) is idle for the digest's purposes; only a lost agent is an error.
 */
export function snapshotActivity(meta: Pick<SessionMeta, "busy" | "awaitingPermission" | "link">) {
  const quiet = meta.link.status === "offline" && meta.link.error === null;
  return agentActivity({ busy: meta.busy, awaitingPermission: meta.awaitingPermission, link: quiet ? null : meta.link });
}

/** How the last turn in `events` ended: its stop reason ("cancelled" when stopped), "error", or null while it is open or none is in view. */
export function lastTurnEnd(events: PortalEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === "turn_end") return event.stopReason;
    if (event.type === "error") return "error";
    if (event.type === "turn_start") return null;
  }
  return null;
}

export type CollectOptions = {
  deps: OrchestratorDeps;
  /** The previous snapshot; a source that fails keeps its slice from here. */
  previous: TickSnapshot | null;
  now: number;
  /** Receives one line per source that could not be read. */
  log: string[];
};

/** Read sessions, attention pulls, worktree states, and missing folders. Never throws. */
export async function collectSnapshot({ deps, previous, now, log }: CollectOptions): Promise<TickSnapshot> {
  const snapshot: TickSnapshot = { at: now, sessions: {}, pulls: {}, worktrees: {}, missingProjects: [] };

  try {
    for (const meta of await deps.sessions.list()) {
      snapshot.sessions[meta.id] = {
        activity: snapshotActivity(meta), lastActiveAt: meta.lastActiveAt, title: meta.title, projectId: meta.projectId, link: meta.link.status,
      };
    }
    // A session that went idle since the last snapshot: a stopped turn is reported as stopped, not finished.
    if (previous) {
      await Promise.all(Object.entries(snapshot.sessions).map(async ([id, session]) => {
        if (session.activity !== "idle" || previous.sessions[id]?.activity === "idle") return;
        const page = await deps.sessions.readEvents(id, { limit: TURN_END_WINDOW }).catch(() => null);
        if (page && lastTurnEnd(page.events) === "cancelled") session.stopped = true;
      }));
    }
  } catch (err) {
    log.push(`Sessions could not be listed (${errorMessage(err)}); kept the previous list.`);
    snapshot.sessions = previous?.sessions ?? {};
  }

  let projects: Project[] | null = null;
  try {
    projects = await deps.projects.list();
  } catch (err) {
    log.push(`Projects could not be listed (${errorMessage(err)}); kept the previous worktree and folder state.`);
  }

  await collectPulls(snapshot, { deps, previous, now, log, projects });

  if (!projects) {
    snapshot.worktrees = previous?.worktrees ?? {};
    snapshot.missingProjects = previous?.missingProjects ?? [];
    return snapshot;
  }
  await collectWorktrees(snapshot, { deps, previous, log, projects });
  const missing = await Promise.all(projects.map((project) => deps.projects.summarize(project).then(
    (summary) => (summary.exists ? null : project.id),
    (err) => {
      log.push(`Project ${project.name} could not be checked (${errorMessage(err)}).`);
      return previous?.missingProjects.includes(project.id) ? project.id : null;
    },
  )));
  snapshot.missingProjects = missing.filter((id): id is string => id !== null).sort();
  return snapshot;
}

type SourceOptions = Omit<CollectOptions, "now"> & { projects: Project[] | null };

async function collectPulls(snapshot: TickSnapshot, { deps, previous, now, log, projects }: SourceOptions & { now: number }) {
  const since = now - STALE_PULL_MS;
  let search: AttentionSearch;
  try {
    search = await deps.github.searchAttentionPulls({ updatedSince: since });
  } catch (err) {
    search = { pulls: [], error: errorMessage(err) };
  }
  if (search.error) {
    log.push(`GitHub search failed (${search.error}); kept the previous pull requests.`);
    snapshot.pulls = previous?.pulls ?? {};
    return;
  }
  if (search.warning) log.push(`GitHub search warning: ${search.warning}`);
  if (search.truncated) {
    const total = search.total ? ` (${search.total.authored} authored, ${search.total.requested} requested in all)` : "";
    log.push(`GitHub search was cut short; not every matching PR was fetched${total}.`);
  }
  // The search filters by day; anything older than the cutoff that slipped through is dropped here.
  let pulls = search.pulls.filter((pull) => pull.updatedAt >= since);
  const stale = search.pulls.length - pulls.length;
  if (stale > 0) log.push(`Skipped ${stale} pull request${stale === 1 ? "" : "s"} untouched for over ${STALE_PULL_MS / 86_400_000} days.`);
  if (projects) {
    const locals: LocalProject[] = await Promise.all(projects.map(async (project) => ({
      id: project.id, path: project.path, remoteUrl: await originUrl(deps, project.path), worktree: project.worktree,
    })));
    pulls = attachLocalProjects(pulls, locals);
  }
  for (const pull of pulls) snapshot.pulls[pullKey(pull)] = pull;
  // The search only returns open PRs. One that left it is carried once more with its final state,
  // so the diff can tell merged from closed; the tick after that drops it.
  for (const [key, pull] of Object.entries(previous?.pulls ?? {})) {
    if (snapshot.pulls[key] || pull.state !== "open") continue;
    const state = await deps.github.pullState(pull.url);
    if (state === "merged" || state === "closed") snapshot.pulls[key] = { ...pull, state };
    else log.push(`${key} left the attention list${state === "open" ? " while still open" : "; its state could not be read"}.`);
  }
}

async function collectWorktrees(snapshot: TickSnapshot, { deps, previous, log, projects }: SourceOptions) {
  const byId = new Map((projects ?? []).map((project) => [project.id, project]));
  const worktrees = (projects ?? []).filter((project): project is Project & { worktree: WorktreeMeta } => !!project.worktree);
  const defaultBranches = new Map<string, Promise<string | null>>();
  const defaultBranch = (repoRoot: string) => {
    let known = defaultBranches.get(repoRoot);
    if (!known) {
      known = deps.git.listBranches(repoRoot).then((listing) => listing.defaultBranch);
      defaultBranches.set(repoRoot, known);
    }
    return known;
  };
  await pool(worktrees, WORKTREE_CONCURRENCY, async (project) => {
    const parent = byId.get(project.worktree.parentId);
    try {
      // Refs are shared across a repository's checkouts, so any of them can judge the branch.
      const repoRoot = await deps.git.repoRootOf((parent ?? project).path);
      const state = await deps.git.worktreeState({
        repoRoot, path: project.path, branch: project.worktree.branch, defaultBranch: await defaultBranch(repoRoot),
      });
      snapshot.worktrees[project.id] = { branch: project.worktree.branch, merged: state.merged, dirty: state.dirty, parentId: parent?.id ?? null };
    } catch (err) {
      log.push(`Worktree ${project.name} could not be read (${errorMessage(err)}).`);
      const kept = previous?.worktrees[project.id];
      if (kept) snapshot.worktrees[project.id] = kept;
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------------------------

function fingerprintOf(kind: ItemKind, key: string): string {
  return `${kind}:${key}`;
}

function sortedKeys(record: Record<string, unknown> | undefined): string[] {
  return Object.keys(record ?? {}).sort();
}

/** Keys of either record, each once, sorted. */
function unionKeys(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): string[] {
  return [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].sort();
}

function sameSet<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}

/** True when no session in the project has been active for `DIRTY_IDLE_MS`. */
function idle(snapshot: TickSnapshot, projectId: string): boolean {
  return !Object.values(snapshot.sessions).some((session) => session.projectId === projectId && snapshot.at - session.lastActiveAt < DIRTY_IDLE_MS);
}

/** True when the worktree is dirty and no session in it has been active for `DIRTY_IDLE_MS`. */
function dirtyAndIdle(snapshot: TickSnapshot, projectId: string): boolean {
  return !!snapshot.worktrees[projectId]?.dirty && idle(snapshot, projectId);
}

/**
 * True when the branch has nothing outside the default branch, the folder is clean, and nobody has
 * worked there for a day. The idle wait matters: a branch just created off the default branch is an
 * ancestor of it too, so without it Portal suggested removing a worktree minutes after making it.
 */
function mergedAndIdle(snapshot: TickSnapshot, projectId: string): boolean {
  const worktree = snapshot.worktrees[projectId];
  return !!worktree?.merged && !worktree.dirty && idle(snapshot, projectId);
}

function pullLinks(pull: PullAttention): ItemLinks {
  const projectId = pull.worktreeProjectId ?? pull.localProjectId;
  return { pull: { repo: pull.repo, number: pull.number, url: pull.url }, ...(projectId ? { projectId } : {}) };
}

/** The reasons an open PR the user authored needs them, most severe first. Empty for closed PRs and pure review requests. */
export function authoredReasons(pull: PullAttention): ItemKind[] {
  const reasons = attentionReasons(pull);
  return authoredKinds.filter((kind) => reasons.includes(kind));
}

/** Open, non-draft PRs whose review the user was asked for, per repo, newest first. */
function reviewGroups(snapshot: TickSnapshot | null): Record<string, PullAttention[]> {
  const groups: Record<string, PullAttention[]> = {};
  for (const pull of Object.values(snapshot?.pulls ?? {})) {
    if (!attentionReasons(pull).includes("pr_review_requested")) continue;
    (groups[pull.repo] ??= []).push(pull);
  }
  for (const group of Object.values(groups)) group.sort((a, b) => b.updatedAt - a.updatedAt || a.number - b.number);
  return groups;
}

const daysAgo = (at: number, now: number) => `${Math.max(0, Math.floor((now - at) / 86_400_000))}d`;

/** The Markdown list an aggregated review item carries as its body. */
export function reviewDetail(pulls: PullAttention[], now: number): string {
  const rows = pulls.slice(0, REVIEW_LIST_ROWS).map((pull) => `- #${pull.number} ${pull.title} (${daysAgo(pull.updatedAt, now)})`);
  if (pulls.length > REVIEW_LIST_ROWS) rows.push(`- +${pulls.length - REVIEW_LIST_ROWS} more`);
  return rows.join("\n");
}

/** Whether the thing an item's fingerprint points at exists in a snapshot; null for kinds without a snapshot subject. */
function subjectPresent(snapshot: TickSnapshot, kind: string, key: string): boolean | null {
  switch (kind) {
    case "session_finished":
    case "session_stopped":
    case "session_waiting":
    case "session_offline":
      return key in snapshot.sessions;
    case "pr":
    case "pr_checks_failing":
    case "pr_changes_requested":
    case "pr_conflicts":
      return key in snapshot.pulls;
    // "pr_merged"/"pr_closed" items are notes about a PR that leaves the snapshot by design; the user closes them.
    case "pr_review_requested":
      // Per repo ("owner/name") since the redesign; per PR ("owner/name#n") before it.
      return key in snapshot.pulls || Object.values(snapshot.pulls).some((pull) => pull.repo === key);
    case "worktree_merged":
    case "worktree_dirty":
      return key in snapshot.worktrees;
    case "folder_missing":
      return snapshot.missingProjects.includes(key);
    default:
      return null;
  }
}

/** What the diff decided about dismissed items, beside the changes it reports. */
export type DismissalOutcome = {
  /** Dismissed items whose condition cleared: the dismissal has done its job and they can be resolved. */
  released: string[];
  /** Fingerprints of changes left out because the user dismissed their item. */
  suppressed: string[];
};

/**
 * What changed between two snapshots, as lines the model turns into items. Pure. With `prev`
 * null (the first tick) only conditions that hold now are reported, never transitions such as
 * "finished". `items` are the open and snoozed items, and the dismissed ones: live items supply
 * `existingItemId` and a condition that cleared names the item it resolves; a dismissed item keeps
 * its condition quiet until it clears (then it is `released` into `dismissals`), so a dismissal
 * sticks instead of coming back as a new item on the next change.
 */
export function diffSnapshots(prev: TickSnapshot | null, next: TickSnapshot, items: Item[], dismissals?: DismissalOutcome): DigestChange[] {
  const live = items.filter((item) => item.status === "open" || item.status === "snoozed");
  const byFingerprint = new Map(live.map((item) => [item.fingerprint, item]));
  const dismissedByFingerprint = new Map(items.filter((item) => item.status === "dismissed").map((item) => [item.fingerprint, item]));
  const changes: DigestChange[] = [];
  const resolving = new Set<string>();
  const released = new Set<string>();
  const report = (kind: ItemKind, fingerprint: string, summary: string, links: ItemLinks, detail?: string) => {
    const existing = byFingerprint.get(fingerprint);
    if (!existing && dismissedByFingerprint.has(fingerprint)) {
      dismissals?.suppressed.push(fingerprint);
      return;
    }
    changes.push({ kind, summary, ...(detail ? { detail } : {}), links, fingerprint, existingItemId: existing?.id ?? null });
  };
  /** A dismissed item whose condition went away: released, so the condition may speak up again when it returns. */
  const release = (fingerprint: string) => {
    const dismissed = dismissedByFingerprint.get(fingerprint);
    if (!dismissed || released.has(dismissed.id)) return;
    released.add(dismissed.id);
    dismissals?.released.push(dismissed.id);
  };
  const condition = (kind: ItemKind, key: string, summary: string, links: ItemLinks) => report(kind, fingerprintOf(kind, key), summary, links);
  /** Only worth a line when an item exists for the condition that went away. */
  const clearedFingerprint = (fingerprint: string, summary: string, links: ItemLinks) => {
    release(fingerprint);
    const item = byFingerprint.get(fingerprint);
    if (!item || resolving.has(item.id)) return;
    resolving.add(item.id);
    changes.push({ kind: item.kind, summary: `${summary}: cleared`, links, fingerprint, existingItemId: item.id, resolvesItemId: item.id });
  };
  const cleared = (kind: ItemKind, key: string, summary: string, links: ItemLinks) => clearedFingerprint(fingerprintOf(kind, key), summary, links);

  for (const id of sortedKeys(next.sessions)) {
    const session = next.sessions[id];
    const before = prev?.sessions[id];
    const links: ItemLinks = { sessionId: id, ...(session.projectId ? { projectId: session.projectId } : {}) };
    const name = session.title ? `"${session.title}"` : id;
    const ended = () => session.stopped
      ? condition("session_stopped", id, `Session ${name} stopped: its turn was cancelled`, links)
      : condition("session_finished", id, `Session ${name} finished its turn`, links);
    // Finished only counts while the user has not come back to the session (a prompt moves lastActiveAt)
    // and while the agent is attached: a session read as idle because Portal restarted did not finish anything.
    if (before?.activity === "working" && session.activity === "idle" && session.link === "live" && session.lastActiveAt <= before.lastActiveAt) ended();
    // A session too short for any tick to see it working: new since the last snapshot, prompted since
    // then (it has a title), and now idle with its agent attached, so its turn ran and ended in between.
    if (prev && !before && session.activity === "idle" && session.link === "live" && session.title !== null && session.lastActiveAt > prev.at) ended();
    if (session.activity === "waiting" && before?.activity !== "waiting") condition("session_waiting", id, `Session ${name} is waiting for your permission`, links);
    if (session.activity === "error" && before?.activity !== "error") condition("session_offline", id, `Session ${name} lost its agent`, links);
    if (session.activity !== "waiting") cleared("session_waiting", id, `Session ${name} is no longer waiting`, links);
    if (session.activity !== "error") cleared("session_offline", id, `Session ${name} is connected again`, links);
    if (session.activity === "working") {
      cleared("session_finished", id, `Session ${name} is working again`, links);
      cleared("session_stopped", id, `Session ${name} is working again`, links);
    }
  }
  for (const id of sortedKeys(prev?.sessions)) {
    if (next.sessions[id]) continue;
    for (const kind of sessionKinds) cleared(kind, id, `Session ${id} was deleted`, { sessionId: id });
  }

  // One item per authored PR that needs the user, whatever the mix of reasons.
  for (const key of unionKeys(next.pulls, prev?.pulls)) {
    const pull = next.pulls[key];
    const before = prev?.pulls[key];
    if (!pull) {
      const links = pullLinks(before!);
      clearedFingerprint(`pr:${key}`, `${key} no longer needs your attention`, links);
      for (const kind of authoredKinds) cleared(kind, key, `${key} no longer needs your attention`, links);
      continue;
    }
    const links = pullLinks(pull);
    const label = `${key} "${pull.title}"`;
    if (pull.state !== "open") {
      if (before?.state !== "open") continue;
      condition(pull.state === "merged" ? "pr_merged" : "pr_closed", key, `${label} was ${pull.state}`, links);
      clearedFingerprint(`pr:${key}`, `${key} was ${pull.state}`, links);
      for (const kind of authoredKinds) cleared(kind, key, `${key} was ${pull.state}`, links);
      continue;
    }
    const reasons = authoredReasons(pull);
    const previousReasons = before?.state === "open" ? authoredReasons(before) : [];
    if (reasons.length > 0 && !sameSet(reasons, previousReasons)) {
      report(reasons[0], `pr:${key}`, `PR ${label} needs attention: ${reasons.map((kind) => authoredReasonText[kind]).join(", ")}`, links);
    }
    if (reasons.length === 0) clearedFingerprint(`pr:${key}`, `${key} no longer needs your attention`, links);
    // Items from before the redesign carried one reason each.
    for (const kind of authoredKinds) if (!reasons.includes(kind)) cleared(kind, key, `${key}: ${authoredReasonText[kind]} no longer applies`, links);
  }

  // Review requests are one item per repo, listing the PRs; the item changes when the set does.
  const nextGroups = reviewGroups(next);
  const prevGroups = reviewGroups(prev);
  for (const repo of unionKeys(nextGroups, prevGroups)) {
    const pulls = nextGroups[repo] ?? [];
    const before = prevGroups[repo] ?? [];
    const fingerprint = `pr_review_requested:${repo}`;
    const projectId = [...pulls, ...before].map((pull) => pull.localProjectId).find((id) => id !== null);
    const links: ItemLinks = projectId ? { projectId } : {};
    if (pulls.length === 0) {
      clearedFingerprint(fingerprint, `No PRs in ${repo} await your review`, links);
      continue;
    }
    if (sameSet(pulls.map((pull) => pull.number), before.map((pull) => pull.number))) continue;
    const count = pulls.length === 1 ? "1 PR" : `${pulls.length} PRs`;
    report("pr_review_requested", fingerprint, `${count} in ${repo} await${pulls.length === 1 ? "s" : ""} your review`, links, reviewDetail(pulls, next.at));
  }
  // Per-PR review items from before the redesign.
  for (const key of unionKeys(next.pulls, prev?.pulls)) {
    const pull = next.pulls[key];
    if (!pull || !attentionReasons(pull).includes("pr_review_requested")) cleared("pr_review_requested", key, `${key} no longer awaits your review`, pull ? pullLinks(pull) : {});
  }

  for (const id of sortedKeys(next.worktrees)) {
    const worktree = next.worktrees[id];
    const links: ItemLinks = { projectId: id };
    if (mergedAndIdle(next, id) && !(prev && mergedAndIdle(prev, id))) {
      condition("worktree_merged", id, `Branch ${worktree.branch} has no commits outside the default branch and has been idle for 24 h; its worktree can be removed`, links);
    }
    if (dirtyAndIdle(next, id) && !(prev && dirtyAndIdle(prev, id))) {
      condition("worktree_dirty", id, `Worktree ${worktree.branch} has uncommitted changes and no session activity for 24 h`, links);
    }
    if (!worktree.merged) cleared("worktree_merged", id, `Branch ${worktree.branch} is no longer merged`, links);
    if (!worktree.dirty) cleared("worktree_dirty", id, `Worktree ${worktree.branch} is clean`, links);
  }
  for (const id of sortedKeys(prev?.worktrees)) {
    if (next.worktrees[id]) continue;
    for (const kind of worktreeKinds) cleared(kind, id, `Worktree ${prev!.worktrees[id].branch} was removed`, { projectId: id });
  }

  for (const id of [...next.missingProjects].sort()) {
    if (!prev?.missingProjects.includes(id)) condition("folder_missing", id, `The folder of project ${id} is missing`, { projectId: id });
  }
  for (const id of [...(prev?.missingProjects ?? [])].sort()) {
    if (!next.missingProjects.includes(id)) cleared("folder_missing", id, `The folder of project ${id} is back`, { projectId: id });
  }

  // An item whose subject is gone from both snapshots (it vanished while the item was snoozed, or
  // before this process saw it) would otherwise stay open (or dismissed) forever.
  if (prev) {
    for (const item of items) {
      if (resolving.has(item.id) || released.has(item.id) || item.createdAt >= prev.at) continue;
      const colon = item.fingerprint.indexOf(":");
      if (colon <= 0) continue;
      const kind = item.fingerprint.slice(0, colon);
      const key = item.fingerprint.slice(colon + 1);
      if (subjectPresent(next, kind, key) === false && subjectPresent(prev, kind, key) === false) {
        clearedFingerprint(item.fingerprint, `${item.title} (${key} is gone)`, item.links);
      }
    }
  }

  return changes;
}

// ---------------------------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------------------------

export type BuildDigestOptions = {
  store: OrchestratorStore;
  snapshot: TickSnapshot;
  prevSnapshot: TickSnapshot | null;
  now: number;
  /** Flip expired snoozes back to open in the store (a tick); false only looks (get_tick_digest). */
  wakeSnoozed?: boolean;
};

/**
 * Everything the tick prompt is built from. Snoozed items whose time has passed are flipped back
 * to open here (and count as open), so the model sees them again without a separate pass.
 */
export async function buildDigest({ store, snapshot, prevSnapshot, now, wakeSnoozed = true }: BuildDigestOptions): Promise<TickDigest> {
  const open: Item[] = [];
  const snoozed: Item[] = [];
  const items = await store.listItems();
  for (const item of items) {
    if (item.status === "open") open.push(item);
    else if (item.status !== "snoozed") continue;
    else if (item.snoozedUntil !== null && item.snoozedUntil <= now) {
      open.push(wakeSnoozed ? await store.updateItem(item.id, { status: "open", snoozedUntil: null }) : item);
    } else snoozed.push(item);
  }
  const dismissed = items.filter((item) => item.status === "dismissed");
  const dismissals: DismissalOutcome = { released: [], suppressed: [] };
  const changes = diffSnapshots(prevSnapshot, snapshot, [...open, ...snoozed, ...dismissed], dismissals);
  return {
    at: now,
    since: prevSnapshot?.at ?? null,
    changes,
    openItems: open.map(({ id, kind, title, fingerprint }) => ({ id, kind, title, fingerprint })),
    ...dismissals,
  };
}
