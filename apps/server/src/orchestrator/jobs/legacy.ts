/**
 * Records from before jobs and intents, as they become ones: an old watch becomes an intent (same
 * id, so items that linked it still do) with a check job every ten minutes while it is active, and
 * an old tick report becomes a run of the tick job. The legacy importer and the data migration
 * (`drizzle/0003_watches_to_intents.sql`) apply the same mapping.
 */
import type { Intent, Job, JobRun } from "@portal/contracts/jobs";
import { normalizeScope } from "../store.ts";
import type { Item, TickReport, Watch } from "../types.ts";
import { TICK_JOB_ID } from "./core.ts";
import { DEFAULT_CHECK_MS, checkTitle } from "./intents.ts";

export const LEGACY_TRIGGER = "Something the notes are waiting for has happened: the user is needed, or the request is fulfilled.";
export const LEGACY_ACTION = "Tell the user what changed and what they need to do; close the intent once the request is fulfilled.";

/** The check job of a migrated watch. */
export const legacyCheckJobId = (watchId: string) => `chk-${watchId}`;

export function intentFromWatch(watch: Watch, now: number): { intent: Intent; job: Job | null } {
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

/** An item as it links intents: `links.watchId` becomes `intentId`, a `watch_update` an `intent_update`. */
export function itemWithIntentLinks(item: Item): Item {
  const { watchId, ...links } = item.links;
  const kind = item.kind === "watch_update" ? "intent_update" : item.kind;
  if (watchId === undefined && kind === item.kind) return item;
  return { ...item, kind, links: watchId === undefined ? links : { ...links, intentId: links.intentId ?? watchId } };
}

export function runFromTick(report: TickReport): JobRun {
  const failed = !!report.error && report.error !== "not ready" && report.error !== "busy";
  return {
    id: report.id, jobId: TICK_JOB_ID, kind: "tick", threadId: null, parentRunId: null, status: failed ? "failed" : "succeeded",
    trigger: report.reason === "manual" ? "manual" : "schedule", startedAt: report.startedAt, finishedAt: report.finishedAt, model: null,
    usage: report.usage, log: report.log, result: report,
    summary: failed ? `Failed: ${report.error}` : report.modelInvoked ? `${report.changes} change(s) considered` : "Nothing changed.",
    error: failed ? report.error : null,
  };
}
