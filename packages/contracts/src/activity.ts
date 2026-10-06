/**
 * The activity log: an append-only record of everything the orchestrator and the user did to it
 * (chat turns, tool calls, items, jobs, intents, memory, approvals). The Activity view reads it and
 * audits rely on it, so every service that acts writes one entry per action through the server's
 * `activity.log()`; nothing ever updates or deletes an entry.
 *
 * HTTP surface:
 *   GET /api/portal/activity?before=<id>&limit=<n>&kind=<prefix>&threadId=&runId=   { entries }  (newest first)
 * Live: the orchestrator stream pushes `{ type: "activity", entry }` for every new entry.
 */
import type { PullRef } from "./orchestrator.ts";

/** Who acted: the user (through the UI), the agent (a model turn), or the server on its own (a job's bookkeeping, a migration). */
export type ActivityActor = "user" | "agent" | "system";

/**
 * Dotted kinds, grouped by prefix so the view can filter (`kind=memory.` matches every memory
 * entry). The list is open: a service may add kinds within its own prefix.
 *
 * chat.turn · run.started · run.finished · tool.call · item.created · item.updated · item.resolved ·
 * item.dismissed · item.action · job.scheduled · job.updated · job.cancelled · intent.created ·
 * intent.updated · intent.fired · intent.closed · thread.created · memory.remembered ·
 * memory.proposed · memory.approved · memory.rejected · memory.forgotten · memory.superseded ·
 * memory.imported · memory.promoted · memory.expired · memory.summarized · memory.consolidated ·
 * approval.requested · approval.decided · approval.executed · world.refreshed · session.tracked ·
 * session.untracked · session.renamed · worktree.kept · worktree.removed_idle · workspace.opened ·
 * workspace.closed · workspace.arranged · workspace.renamed
 *
 * `session.tracked` and `session.untracked` carry `refs.sessionId` and `detail.trackedBy` (who:
 * "user" or "portal"), plus `detail.reason` when one was given. `session.renamed` (the
 * orchestrator's `rename_session`) carries `refs.sessionId` and `detail.from`, `detail.to`.
 *
 * `worktree.kept` and `worktree.removed_idle` come from the lifecycle sweep (an idle worktree project
 * kept, with `detail.reason`, logged only when the reason changes; or removed, with `detail.branch`
 * and `detail.branchDeleted`) and carry `refs.projectId`.
 *
 * `workspace.*` entries come from the workspace service (docs/WORKSPACE.md), each with `detail.tabId` and
 * `refs.sessionId` where there is one: `workspace.opened` (a session or start page opened in a tab or
 * pane), `workspace.closed` (`detail.what`: "tab" or "pane"), `workspace.arranged` (`detail.preset`,
 * `detail.sessionIds`), `workspace.renamed` (`detail.from`, `detail.to`). `resize` and `move_tab` are
 * not logged.
 *
 * `item.resolved` and `item.dismissed` from the bulk route (`POST /api/portal/items/bulk`) are one
 * entry per batch: `detail.itemIds` lists the items, and `refs.itemId` is set only when there was one.
 */
export type ActivityKind = string;

/** What an entry is about; every id the UI can link to. */
export type ActivityRefs = {
  threadId?: string;
  runId?: string;
  jobId?: string;
  intentId?: string;
  itemId?: string;
  approvalId?: string;
  recordId?: string;
  entityId?: string;
  projectId?: string;
  sessionId?: string;
  pull?: PullRef;
};

export type ActivityEntry = {
  /** Monotonic; pages go by `before=<id>`. */
  id: number;
  at: number;
  actor: ActivityActor;
  kind: ActivityKind;
  /** One sentence a person can read in the log, with names rather than ids. */
  summary: string;
  refs: ActivityRefs;
  /** Structured extras (a tool's input, a diff, counts). Never secrets; capped by the server. */
  detail: Record<string, unknown> | null;
};

/** What a service hands to `activity.log()`; the log assigns `id` and, unless given, `at`. */
export type ActivityInput = Omit<ActivityEntry, "id" | "at" | "refs" | "detail"> & {
  at?: number;
  refs?: ActivityRefs;
  detail?: Record<string, unknown> | null;
};
