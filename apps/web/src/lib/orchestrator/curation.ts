/**
 * Memory curation (the consolidator) in the UI: the three settings fields as typed text, and the
 * runs it leaves (their result read defensively, their changes grouped for the diff view).
 */
import { isClockTime, orchestratorLimits } from "../settings.ts";
import type { ConsolidationSettings } from "./types.ts";

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
