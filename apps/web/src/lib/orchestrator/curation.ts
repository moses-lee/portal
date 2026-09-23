/**
 * Memory curation (the consolidator) in the UI: the three settings fields as typed text, and the
 * runs it leaves (their result read defensively, their changes grouped for the diff view).
 */
import { isClockTime, orchestratorLimits } from "../settings.ts";
import { curationActions, type ConsolidationResult, type ConsolidationSettings, type CurationAction, type CurationChange, type JobRun } from "./types.ts";

export type ConsolidationField = keyof ConsolidationSettings;
export const consolidationFields: readonly ConsolidationField[] = ["nightlyAt", "inboxThreshold", "minIntervalMinutes"];

/** A stored value as the field shows it: an empty field means the trigger is off. */
export function consolidationInput(settings: ConsolidationSettings, field: ConsolidationField): string {
  const value = settings[field];
  return value === null ? "" : String(value);
}

/**
 * Typed text back to a setting, or a message: blank turns the nightly run or the inbox trigger off
 * (the interval cannot be blank), and numbers stay within the server's limits.
 */
export function parseConsolidationInput(field: ConsolidationField, text: string): { value: string | number | null } | { error: string } {
  const trimmed = text.trim();
  if (field === "nightlyAt") {
    if (!trimmed) return { value: null };
    return isClockTime(trimmed) ? { value: trimmed } : { error: "Enter a time as HH:MM, or leave it empty to turn the nightly run off." };
  }
  if (!trimmed && field === "inboxThreshold") return { value: null };
  const max = orchestratorLimits[field];
  const number = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  if (number >= 1 && number <= max) return { value: number };
  return {
    error: field === "inboxThreshold"
      ? `Enter a whole number between 1 and ${max}, or leave it empty to turn this off.`
      : `Enter a whole number of minutes between 1 and ${max}.`,
  };
}

/** The consolidate job's id, as the server seeds it. */
export const CONSOLIDATE_JOB_ID = "consolidate";

/** A run's result as a curation result, or null when it is not one (a run still going, an older shape). */
export function consolidationResult(run: Pick<JobRun, "result">): ConsolidationResult | null {
  const result = run.result as Partial<ConsolidationResult> | null;
  if (!result || typeof result !== "object" || typeof result.digest !== "string" || !Array.isArray(result.changes) || !result.counts) return null;
  return result as ConsolidationResult;
}

export const curationLabels: Record<CurationAction, string> = {
  promoted: "Promoted",
  superseded: "Replaced",
  rejected: "Rejected",
  expired: "Expired",
  left: "Left for you",
  reconfirm: "Please re-confirm",
  summarized: "Summaries rewritten",
};

export type CurationGroup = { action: CurationAction; label: string; changes: CurationChange[] };

/** The diff grouped by action, in the contract's order; empty groups left out. */
export function groupChanges(changes: readonly CurationChange[]): CurationGroup[] {
  return curationActions.flatMap((action) => {
    const matching = changes.filter((change) => change.action === action);
    return matching.length ? [{ action, label: curationLabels[action], changes: matching }] : [];
  });
}

/** One line for a curation run in the list: its summary, else what state it is in. */
export function curationRunLine(run: Pick<JobRun, "status" | "summary" | "error" | "result">): string {
  if (run.status === "running") return "Curating…";
  const result = consolidationResult(run);
  if (result) return result.line;
  if (run.summary) return run.summary;
  if (run.error) return `Failed: ${run.error}`;
  return run.status === "cancelled" ? "Stopped." : "No details recorded.";
}
