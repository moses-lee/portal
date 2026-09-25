/**
 * One curation pass, as the `consolidate` job runs it: read the inbox, the active records, and the
 * entities; let a curation turn on the chat role look at them and submit a plan (its only tools are
 * `submit_curation_plan` and `search_memory`); read the records again, resolve the plan by the rules
 * in `curation.ts`, and either refuse it whole or apply it in one commit; keep the Needs-you item
 * that lists the user's own claims to re-confirm in step; and answer the digest and the diff as the
 * run's `ConsolidationResult`. The job posts the digest line; this module never writes to a thread.
 */
import type { ConsolidationResult, MemoryEntity, MemoryRecord } from "@portal/contracts/memory";
import type { JobRun, RunTrigger } from "@portal/contracts/jobs";
import type { OrchestratorHub } from "../hub.ts";
import { generateTurn, prepareTurn } from "../turn.ts";
import { entityLabel } from "./core.ts";
import {
  type CurationPlan, type ResolvedPlan, curationPrompt, digestLine, emptyCounts, needsModel, planChanges, planCounts, renderDigest, resolvePlan,
} from "./curation.ts";
import type { CuratedMemoryService } from "./service.ts";

/** The curation turn's tools: its plan, and a look at older records for evidence. */
export const CURATION_TOOLS = ["submit_curation_plan", "search_memory"] as const;
export const CURATION_STEPS = 12;
/** The one Needs-you item that lists the user's claims past their review date, updated in place. */
export const RECONFIRM_FINGERPRINT = "memory_reconfirm";
/** Claims listed in the re-confirm item before "and N more". */
const RECONFIRM_LINES = 15;

export type CurationOutcome = {
  status: "succeeded" | "failed";
  result: ConsolidationResult;
  log: string[];
  error: string | null;
  /** No API key: nothing was read or changed. */
  skipped?: boolean;
};

/** The hub's memory as the curated service, or null when a test replaced it with something narrower. */
function curatedMemory(hub: OrchestratorHub): CuratedMemoryService | null {
  const memory = hub.memory as Partial<CuratedMemoryService>;
  return typeof memory.applyCuration === "function" ? (memory as CuratedMemoryService) : null;
}

function emptyResult(line: string): ConsolidationResult {
  return { digest: line, line, counts: emptyCounts(), changes: [], refused: null, considered: { inbox: 0, active: 0, overdue: 0, entities: 0 }, note: null };
}

const oneLine = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** The re-confirm item's body: what to do, then the claims. */
export function reconfirmBody(records: MemoryRecord[], entities: Map<string, MemoryEntity>): string {
  const lines = records.slice(0, RECONFIRM_LINES).map((record) => {
    const entity = entities.get(record.entityId);
    const due = record.reviewBy !== null ? ` (review by ${new Date(record.reviewBy).toISOString().slice(0, 10)})` : "";
    return `- ${entity ? entityLabel(entity) : record.entityId} · \`${record.key}\`: ${oneLine(record.body, 140)}${due}`;
  });
  if (records.length > RECONFIRM_LINES) lines.push(`- … and ${records.length - RECONFIRM_LINES} more`);
  return [
    "These claims you stated or confirmed are past their review date. They stay in force; open Memory to keep each one (edit it or its review date) or forget it.",
    "",
    ...lines,
  ].join("\n").slice(0, 2000);
}

/**
 * Bring the re-confirm item in line with `records`: created, updated in place, or resolved when
 * nothing is overdue. A list the user dismissed is not raised again until it changes.
 */
export async function syncReconfirmItem(hub: OrchestratorHub, records: MemoryRecord[], entities: Map<string, MemoryEntity>, jobId: string | null): Promise<void> {
  const live = await hub.store.findItemByFingerprint(RECONFIRM_FINGERPRINT);
  let changed = false;
  if (records.length === 0) {
    if (live) {
      await hub.store.updateItem(live.id, { status: "resolved", snoozedUntil: null });
      changed = true;
    }
  } else {
    const title = `Re-confirm ${records.length === 1 ? "a memory claim" : `${records.length} memory claims`} of yours`;
    const body = reconfirmBody(records, entities);
    if (live) {
      if (live.title !== title || live.body !== body) {
        await hub.store.updateItem(live.id, { title, body });
        changed = true;
      }
    } else {
      const dismissed = (await hub.store.listItems()).some((item) => item.fingerprint === RECONFIRM_FINGERPRINT && item.status === "dismissed" && item.body === body);
      if (!dismissed) {
        await hub.store.createItem({ kind: "memory_reconfirm", title, body, links: jobId ? { jobId } : {}, actions: [], fingerprint: RECONFIRM_FINGERPRINT });
        changed = true;
      }
    }
  }
  if (changed) hub.emit({ type: "items", items: await hub.store.listItems() });
}

/**
 * Run one pass for `run` (the job's run; the curation turn records into it). Failures of the turn
 * are thrown for the job to record; a refused plan is answered as a failed outcome with its digest.
 */
export async function runCuration(hub: OrchestratorHub, { run, jobId, trigger, signal }: {
  run: Pick<JobRun, "id">;
  jobId: string | null;
  trigger: RunTrigger;
  signal: AbortSignal;
}): Promise<CurationOutcome> {
  const log: string[] = [];
  const memory = curatedMemory(hub);
  if (!memory) return { status: "failed", result: emptyResult("Curated memory is not available."), log, error: "Curated memory is not available." };
  if (!(await hub.model("chat"))) {
    const line = "No API key is stored; memory was not curated.";
    return { status: "succeeded", result: { ...emptyResult(line), skipped: true }, log: [line], error: null, skipped: true };
  }

  const before = await memory.curationSnapshot();
  let plan: CurationPlan = { decisions: [], summaries: [] };
  if (needsModel(before)) {
    const prepared = await prepareTurn(hub, {
      kind: "consolidate", role: "chat", trigger, threadId: null, jobId, interactive: false, toolNames: CURATION_TOOLS, query: "",
      touched: new Set(), summary: "Curating memory",
    });
    if (!prepared) {
      const line = "No API key is stored; memory was not curated.";
      return { status: "succeeded", result: { ...emptyResult(line), skipped: true }, log: [line], error: null, skipped: true };
    }
    const turn = await generateTurn(prepared, { prompt: curationPrompt(before), signal, maxSteps: CURATION_STEPS, summarize: () => null });
    log.push(`The curation turn took ${turn.steps} step(s)${turn.text ? `: ${oneLine(turn.text, 200)}` : "."}`);
    const submitted = memory.takeCurationPlan(run.id);
    if (!submitted) {
      const line = "The curation turn submitted no plan; nothing was changed.";
      return { status: "failed", result: emptyResult(line), log: [...log, line], error: line };
    }
    plan = submitted;
  } else {
    log.push("Nothing in the inbox and no summary to write; only the review dates were checked.");
  }

  // Decide on the records as they are now: the user may have approved or rejected some meanwhile.
  const now = await memory.curationSnapshot();
  const resolved: ResolvedPlan = resolvePlan(now, plan);
  const entities = new Map(now.entities.map((entity) => [entity.id, entity]));
  for (const issue of resolved.issues) log.push(`Ignored: ${issue}`);
  let written: Map<string, MemoryRecord> | null = null;
  if (resolved.refused) {
    log.push(`Refused: ${resolved.refused}`);
  } else {
    written = (await memory.applyCuration(resolved, { runId: run.id })).written;
    await syncReconfirmItem(hub, resolved.reconfirm, entities, jobId).catch((err: unknown) => {
      log.push(`Could not update the re-confirm item: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
  const changes = planChanges(resolved, entities, written);
  const counts = planCounts(resolved);
  const result: ConsolidationResult = {
    digest: renderDigest(resolved, changes), line: digestLine({ counts, refused: resolved.refused }), counts, changes, refused: resolved.refused,
    considered: { inbox: now.inbox.length, active: now.active.length, overdue: resolved.expire.length + resolved.reconfirm.length, entities: now.entities.length },
    note: resolved.note,
  };
  log.push(result.line);
  return { status: resolved.refused ? "failed" : "succeeded", result, log, error: resolved.refused };
}
