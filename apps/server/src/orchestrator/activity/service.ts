/**
 * `activity.log()`: the one way anything in the orchestrator records what it did. Each entry is
 * stored and pushed to the page as it happens. Logging never throws: an audit write that fails is
 * reported on the console, and the action it describes goes ahead.
 */
import type { ActivityEntry, ActivityInput } from "@portal/contracts/activity";
import type { OrchestratorEvent } from "../types.ts";
import type { ActivityFilter, ActivityStore } from "./store.ts";

/** Longest `detail`, as JSON; larger ones are replaced by a note saying how large they were. */
export const MAX_DETAIL_BYTES = 8 * 1024;
/** Longest summary, in characters. */
export const MAX_SUMMARY_CHARS = 500;

export interface ActivityService {
  /** Store and publish one entry; resolves with it, or null when it could not be stored. */
  log(input: ActivityInput): Promise<ActivityEntry | null>;
  list(filter?: ActivityFilter): Promise<ActivityEntry[]>;
}

export function capDetail(detail: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!detail) return null;
  let text: string | undefined;
  try {
    text = JSON.stringify(detail);
  } catch {
    return { note: "detail could not be serialized" };
  }
  if (text === undefined) return null;
  const bytes = Buffer.byteLength(text, "utf8");
  return bytes <= MAX_DETAIL_BYTES ? detail : { note: `detail omitted (${bytes} bytes)` };
}

export function createActivityService({ store, emit, now = Date.now }: {
  store: ActivityStore;
  emit: (event: OrchestratorEvent) => void;
  now?: () => number;
}): ActivityService {
  return {
    async log(input) {
      const summary = input.summary.length > MAX_SUMMARY_CHARS ? `${input.summary.slice(0, MAX_SUMMARY_CHARS - 1)}…` : input.summary;
      try {
        const entry = await store.append({
          at: input.at ?? now(), actor: input.actor, kind: input.kind, summary, refs: input.refs ?? {}, detail: capDetail(input.detail),
        });
        emit({ type: "activity", entry });
        return entry;
      } catch (err) {
        console.error(`Could not record activity "${input.kind}":`, err);
        return null;
      }
    },
    list: (filter) => store.list(filter),
  };
}
