/**
 * Records from before jobs and intents, as they become ones: an old watch becomes an intent (same
 * id, so items that linked it still do) with a check job every ten minutes while it is active, an
 * old item loses its list (the Ideas list is gone: open ideas are resolved), and an old tick report
 * becomes a run of the tick job. The legacy importer and the data migrations
 * (`drizzle/0003_watches_to_intents.sql`, `0005_items_without_lists.sql`) apply the same mapping.
 */
import type { Intent, Job, JobRun } from "@portal/contracts/jobs";
import { normalizeScope } from "../store.ts";
import type { Item, PullRef, TickReason } from "../types.ts";
import { TICK_JOB_ID } from "./core.ts";
import { DEFAULT_CHECK_MS, checkTitle } from "./intents.ts";

export const LEGACY_TRIGGER = "Something the notes are waiting for has happened: the user is needed, or the request is fulfilled.";
export const LEGACY_ACTION = "Tell the user what changed and what they need to do; close the intent once the request is fulfilled.";

/**
 * A tick report as the old orchestrator stored it, from when the tick called the bookkeeping model
 * on changes (the refresh that replaced it reports a `RefreshReport`, see `tick.ts`).
 */
export type LegacyTickReport = {
  id: string;
  reason: TickReason;
  startedAt: number;
  finishedAt: number;
  modelInvoked?: boolean;
  changes?: number;
  itemsCreated?: string[];
  itemsUpdated?: string[];
  itemsResolved?: string[];
  log: string[];
  error: string | null;
  usage?: { inputTokens: number; outputTokens: number } | null;
  capped?: boolean;
};

/** A watch as the old orchestrator stored it: a tracked request that every tick followed up on. */
export type LegacyWatch = {
  id: string;
  intent: string;
  notes: string;
  status: "active" | "done" | "cancelled";
  links: { sessionIds: string[]; projectIds: string[]; pulls: PullRef[] };
  createdAt: number;
  updatedAt: number;
  lastCheckedAt: number | null;
};

/** An item as the old orchestrator stored it: on a list, and possibly linking a watch. */
export type LegacyItem = Omit<Item, "links"> & { list?: string; links: Item["links"] & { watchId?: string } };

/** The check job of a migrated watch. */
export const legacyCheckJobId = (watchId: string) => `chk-${watchId}`;

export function intentFromWatch(watch: LegacyWatch, now: number): { intent: Intent; job: Job | null } {
  const status = watch.status === "active" ? "active" : watch.status === "done" ? "done" : "cancelled";
  const pulls = watch.links?.pulls ?? [];
  const intent: Intent = {
    id: watch.id, text: watch.intent.trim() || "(no description)", trigger: LEGACY_TRIGGER, action: LEGACY_ACTION, notes: watch.notes,
    scope: normalizeScope({ projectIds: watch.links?.projectIds, sessionIds: watch.links?.sessionIds, pulls, repos: pulls.map((pull) => pull.repo) }),
    status, expiresAt: null, fireBudget: null, fires: 0, cooldownMs: 0, lastFiredAt: null, lastCheckedAt: watch.lastCheckedAt, threadId: null,
    createdAt: watch.createdAt, updatedAt: watch.updatedAt,
  };
  const job: Job | null = status !== "active" ? null : {
    id: legacyCheckJobId(watch.id), kind: "intent_check", title: checkTitle(intent.text), schedule: { type: "every", everyMs: DEFAULT_CHECK_MS },
    payload: { intentId: watch.id }, status: "active", nextRunAt: now + DEFAULT_CHECK_MS, lastRunAt: watch.lastCheckedAt, lastRunId: null,
    intentId: watch.id, threadId: null, createdBy: "system", failures: 0, createdAt: now, updatedAt: now,
  };
  return { intent, job };
}

/**
 * An old item as it is kept now: no list (an open or snoozed idea is resolved, since only Needs-you
 * items are shown), `links.watchId` becomes `intentId`, a `watch_update` an `intent_update`.
 */
export function itemFromLegacy(legacy: LegacyItem): Item {
  const { list, links: legacyLinks, ...rest } = legacy;
  const { watchId, ...links } = legacyLinks;
  const kind = rest.kind === "watch_update" ? "intent_update" : rest.kind;
  const idea = list === "ideas" && (rest.status === "open" || rest.status === "snoozed");
  return {
    ...rest, kind, links: watchId === undefined ? links : { ...links, intentId: links.intentId ?? watchId },
    ...(idea ? { status: "resolved" as const, snoozedUntil: null } : {}),
  };
}

export function runFromTick(report: LegacyTickReport): JobRun {
  const failed = !!report.error && report.error !== "not ready" && report.error !== "busy";
  return {
    id: report.id, jobId: TICK_JOB_ID, kind: "tick", threadId: null, parentRunId: null, status: failed ? "failed" : "succeeded",
    trigger: report.reason === "manual" ? "manual" : "schedule", startedAt: report.startedAt, finishedAt: report.finishedAt, model: null,
    usage: report.usage ?? null, log: report.log, result: report,
    summary: failed ? `Failed: ${report.error}` : report.modelInvoked ? `${report.changes} change(s) considered` : "Nothing changed.",
    error: failed ? report.error : null,
  };
}
