/**
 * Pure readers for the files the Next.js app kept under `~/.portal` (or `$PORTAL_HOME`): each turns
 * one domain's files into validated, NUL-free records plus warnings, parsing exactly as the old
 * file stores did so the import sees what the old app showed. Nothing here touches the database or
 * changes a file. A missing file reads as "nothing to import"; a file that exists but cannot be read
 * (EACCES, EISDIR) throws, since silently skipping it would lose the user's data.
 */
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { StoredEvent } from "@portal/contracts/types";
import {
  MAX_TICK_REPORTS, capMemory, isItem, isOrchestratorMessage, isTickReport, isTickSnapshot, isWatch,
} from "../lib/orchestrator/store.ts";
import type { Item, OrchestratorMessage, TickReport, TickSnapshot, Watch } from "../lib/orchestrator/types.ts";
import { SettingsError, parseSettingsFile, parseSettingsPatch } from "../lib/settings-store.ts";
import type { Project, RemovedProject } from "../lib/types.ts";
import { dropLegacyWorktreeNames, legacyProjectsFile, parseLegacyProjectsFile } from "../projects/legacy.ts";
import { isSessionRecord, isStoredEvent, type SessionRecord } from "../sessions/store.ts";
import { stripNul } from "./sanitize.ts";

/** A file's text, or null when it does not exist. */
async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw new Error(`Cannot read ${file}: ${(err as Error).message}`, { cause: err });
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

export const legacyFiles = {
  projects: legacyProjectsFile,
  settings: (home: string) => path.join(home, "settings.json"),
  sessionsIndex: (home: string) => path.join(home, "sessions", "index.json"),
  sessionLog: (home: string, id: string) => path.join(home, "sessions", "logs", `${id}.jsonl`),
  orchestrator: (home: string, name: OrchestratorFile) => path.join(home, "orchestrator", name),
};

const orchestratorFiles = ["conversation.json", "items.json", "watches.json", "snapshot.json", "ticks.json", "memory.md"] as const;
type OrchestratorFile = (typeof orchestratorFiles)[number];

/** Every legacy file whose presence means there is something to import. */
export function legacyDataFiles(home: string): string[] {
  return [
    legacyFiles.projects(home),
    legacyFiles.settings(home),
    legacyFiles.sessionsIndex(home),
    ...orchestratorFiles.map((name) => legacyFiles.orchestrator(home, name)),
  ];
}

// ---------------------------------------------------------------------------------------------
// Projects: <home>/projects.json
// ---------------------------------------------------------------------------------------------

export type LegacyProjects = { projects: Project[]; removed: RemovedProject[]; warnings: string[] };

/**
 * Listed projects in file order (with the old "<parent> · <branch>" worktree names dropped, as the
 * old store did on load) and the removed records. A removed record whose id is also listed is
 * dropped: a project is in one table or the other.
 */
export async function readLegacyProjects(home: string): Promise<LegacyProjects | null> {
  const file = legacyFiles.projects(home);
  const text = await readText(file);
  if (text === null) return null;
  const parsed = parseLegacyProjectsFile(text);
  if (!parsed) return { projects: [], removed: [], warnings: [`${file} is not a readable projects file; no projects were imported from it.`] };
  const warnings: string[] = [];
  if (parsed.droppedRemoved > 0) warnings.push(`Dropped ${plural(parsed.droppedRemoved, "unreadable removed project")} from ${file}.`);
  const projects: Project[] = [];
  const seen = new Set<string>();
  for (const project of dropLegacyWorktreeNames(parsed.projects) ?? parsed.projects) {
    // The old store keyed a Map by id: the first position wins, the last value is what it kept.
    if (seen.has(project.id)) {
      projects[projects.findIndex((p) => p.id === project.id)] = stripNul(project);
      continue;
    }
    seen.add(project.id);
    projects.push(stripNul(project));
  }
  const removed = new Map<string, RemovedProject>();
  let shadowed = 0;
  for (const record of parsed.removed) {
    if (seen.has(record.id)) shadowed++;
    else removed.set(record.id, stripNul(record));
  }
  if (shadowed > 0) warnings.push(`Dropped ${plural(shadowed, "removed project record")} from ${file} whose project is still listed.`);
  return { projects, removed: [...removed.values()], warnings };
}

// ---------------------------------------------------------------------------------------------
// Settings: <home>/settings.json
// ---------------------------------------------------------------------------------------------

export type LegacySettings = {
  file: string;
  /** False when the file is not a JSON object: nothing came from it, and it is left where it is for the user to look at. */
  parsed: boolean;
  /** A valid settings PATCH body, API keys included under `orchestrator.apiKeys`. */
  patch: Record<string, unknown>;
  sections: number;
  apiKeys: number;
  warnings: string[];
};

/**
 * The file's overrides and API keys as a PATCH body. The file parser is lenient field by field;
 * the PATCH parser is stricter in one place (prompt length), so a section it rejects is dropped
 * with a warning instead of failing the whole import.
 */
export async function readLegacySettings(home: string): Promise<LegacySettings | null> {
  const file = legacyFiles.settings(home);
  const text = await readText(file);
  if (text === null) return null;
  const overrides = parseSettingsFile(text);
  if (!overrides) return { file, parsed: false, patch: {}, sections: 0, apiKeys: 0, warnings: [`${file} is not a JSON object; no settings were imported from it.`] };
  const warnings: string[] = [];
  const patch: Record<string, unknown> = {};
  for (const [section, value] of Object.entries(stripNul(overrides))) {
    try {
      parseSettingsPatch({ [section]: value });
      patch[section] = value;
    } catch (err) {
      if (!(err instanceof SettingsError)) throw err;
      warnings.push(`Skipped the ${section} settings from ${file}: ${err.message}`);
    }
  }
  const apiKeys = Object.keys((patch.orchestrator as { apiKeys?: object } | undefined)?.apiKeys ?? {}).length;
  return { file, parsed: true, patch, sections: Object.keys(patch).length, apiKeys, warnings };
}

// ---------------------------------------------------------------------------------------------
// Sessions: <home>/sessions/index.json and <home>/sessions/logs/<id>.jsonl
// ---------------------------------------------------------------------------------------------

export type LegacySessions = {
  /** In index order. */
  sessions: SessionRecord[];
  warnings: string[];
  /**
   * The session's events in seq order, in batches of at most `batchSize`, streamed so a long log
   * never sits in memory whole. Problems found while reading are pushed onto `warnings`.
   */
  events(id: string, batchSize: number): AsyncGenerator<StoredEvent[]>;
};

/** Same test as the old store: a version-1 index whose every record passes, or nothing. */
function parseIndex(text: string): SessionRecord[] | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  const file = parsed as { version?: unknown; sessions?: unknown } | null;
  if (!file || typeof file !== "object" || file.version !== 1 || !Array.isArray(file.sessions)) return null;
  return file.sessions.every(isSessionRecord) ? (file.sessions as SessionRecord[]) : null;
}

export async function readLegacySessions(home: string): Promise<LegacySessions | null> {
  const file = legacyFiles.sessionsIndex(home);
  const text = await readText(file);
  if (text === null) return null;
  const warnings: string[] = [];
  const loaded = parseIndex(text);
  if (!loaded) warnings.push(`${file} is not a readable sessions index; no sessions were imported from it.`);
  // A Map, as the old store used: a repeated id keeps its first position and its last record.
  const sessions = new Map((loaded ?? []).map((record) => [record.id, stripNul(record)]));
  return {
    sessions: [...sessions.values()],
    warnings,
    events: (id, batchSize) => readLog(legacyFiles.sessionLog(home, id), batchSize, warnings),
  };
}

const NEWLINE = 0x0a;

/**
 * One log, oldest first. Mirrors the old store: blank lines are skipped, a line that is not a
 * stored event is skipped with a warning, and a last line without its newline (a crash mid-append)
 * is dropped, since the old store truncated it away on open. Seqs must rise; a repeated or
 * backwards seq (only a hand edit could produce one) is skipped so each (session, seq) stays unique.
 */
async function* readLog(file: string, batchSize: number, warnings: string[]): AsyncGenerator<StoredEvent[]> {
  let stream: AsyncIterable<Buffer>;
  try {
    stream = createReadStream(file);
    // Opening is lazy; fail here (not mid-iteration) so a missing log reads as empty.
    await new Promise<void>((resolve, reject) => {
      (stream as ReturnType<typeof createReadStream>).once("open", () => resolve()).once("error", reject);
    });
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return;
    throw new Error(`Cannot read ${file}: ${(err as Error).message}`, { cause: err });
  }
  let carry = Buffer.alloc(0);
  let batch: StoredEvent[] = [];
  let last = -1;
  let unreadable = 0;
  let outOfOrder = 0;
  const take = (line: Buffer) => {
    if (line.length === 0) return;
    let event: unknown;
    try { event = JSON.parse(line.toString("utf8")); } catch { event = null; }
    if (!isStoredEvent(event)) {
      unreadable++;
      return;
    }
    if (event.seq <= last) {
      outOfOrder++;
      return;
    }
    last = event.seq;
    batch.push(stripNul(event));
  };
  for await (const chunk of stream) {
    const buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    let start = 0;
    for (let i = buffer.indexOf(NEWLINE); i !== -1; i = buffer.indexOf(NEWLINE, start)) {
      take(buffer.subarray(start, i));
      start = i + 1;
    }
    carry = Buffer.from(buffer.subarray(start));
    if (batch.length >= batchSize) {
      // Yield whole batches; a remainder waits for the next chunk.
      while (batch.length >= batchSize) yield batch.splice(0, batchSize);
    }
  }
  if (carry.length > 0) warnings.push(`Dropped a torn last line from ${file}.`);
  if (unreadable > 0) warnings.push(`Skipped ${plural(unreadable, "unreadable line")} in ${file}.`);
  if (outOfOrder > 0) warnings.push(`Skipped ${plural(outOfOrder, "event")} in ${file} whose seq did not follow the one before.`);
  if (batch.length > 0) yield batch;
}

// ---------------------------------------------------------------------------------------------
// Orchestrator: <home>/orchestrator/*
// ---------------------------------------------------------------------------------------------

export type LegacyOrchestrator = {
  /** Thread order. */
  messages: OrchestratorMessage[];
  /** Oldest first (ascending createdAt), so inserting in order numbers them the way new records would be. */
  items: Item[];
  watches: Watch[];
  /** The newest MAX_TICK_REPORTS, oldest first. */
  ticks: TickReport[];
  snapshot: TickSnapshot | null;
  /** Null when there is no memory file. */
  memory: string | null;
  warnings: string[];
};

/**
 * The orchestrator's documents. `*.corrupt-*` and `*.tmp-*` siblings are never read: only the six
 * exact names are. A document that is not JSON (or not an array) imports as empty, as the old store
 * loaded it; records the guards reject are dropped one by one.
 */
export async function readLegacyOrchestrator(home: string): Promise<LegacyOrchestrator | null> {
  const texts = await Promise.all(orchestratorFiles.map((name) => readText(legacyFiles.orchestrator(home, name))));
  if (texts.every((text) => text === null)) return null;
  const text = Object.fromEntries(orchestratorFiles.map((name, i) => [name, texts[i]])) as Record<OrchestratorFile, string | null>;
  const warnings: string[] = [];

  function list<T>(name: OrchestratorFile, check: (value: unknown) => value is T): T[] {
    const source = text[name];
    if (source === null) return [];
    const file = legacyFiles.orchestrator(home, name);
    let parsed: unknown;
    try { parsed = JSON.parse(source); } catch { parsed = undefined; }
    if (!Array.isArray(parsed)) {
      warnings.push(`${file} is not a JSON array; nothing was imported from it.`);
      return [];
    }
    const kept = parsed.filter(check);
    if (kept.length < parsed.length) warnings.push(`Dropped ${plural(parsed.length - kept.length, "unreadable record")} from ${file}.`);
    return kept.map(stripNul);
  }

  /** First of each id (the old store's `find` answered with the first), then oldest first; sort is stable. */
  function byCreation<T extends { id: string; createdAt: number }>(name: OrchestratorFile, records: T[]): T[] {
    const seen = new Set<string>();
    const unique = records.filter((record) => !seen.has(record.id) && !!seen.add(record.id));
    if (unique.length < records.length) {
      warnings.push(`Dropped ${plural(records.length - unique.length, "duplicate id")} from ${legacyFiles.orchestrator(home, name)}.`);
    }
    return unique.sort((a, b) => a.createdAt - b.createdAt);
  }

  let snapshot: TickSnapshot | null = null;
  if (text["snapshot.json"] !== null) {
    let parsed: unknown;
    try { parsed = JSON.parse(text["snapshot.json"]); } catch { parsed = undefined; }
    if (parsed === null || isTickSnapshot(parsed)) snapshot = parsed === null ? null : stripNul(parsed);
    else warnings.push(`${legacyFiles.orchestrator(home, "snapshot.json")} is not a tick snapshot; it was not imported.`);
  }

  return {
    messages: list("conversation.json", isOrchestratorMessage),
    items: byCreation("items.json", list("items.json", isItem)),
    watches: byCreation("watches.json", list("watches.json", isWatch)),
    ticks: list("ticks.json", isTickReport).slice(-MAX_TICK_REPORTS),
    snapshot,
    memory: text["memory.md"] === null ? null : capMemory(stripNul(text["memory.md"])),
    warnings,
  };
}
