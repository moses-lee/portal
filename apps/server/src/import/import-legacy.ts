/**
 * The one-time move of a user's legacy `~/.portal` JSON files into Postgres. Every domain is read
 * first (so a file that cannot be read fails the import before anything is written), then written
 * in one transaction: either the whole home lands, with its marker row, or none of it does. The
 * files stay where they are as a backup, except `settings.json`: it holds the API keys in plain
 * text, so once they are sealed into `credentials` it is renamed out of the way and made 0600.
 *
 * Idempotent: the `legacy_import` settings row marks a finished import and a second run is a no-op
 * unless forced. A forced run merges: rows whose id already exists are kept as they are, and the
 * orchestrator's thread, ticks, snapshot and memory are only written into an empty table.
 */
import { chmod, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { count, eq, inArray, sql } from "drizzle-orm";
import type { StoredEvent } from "@portal/contracts/types";
import type { Db } from "../db/client.ts";
import {
  orchestratorDocuments, orchestratorItems, orchestratorMessages, orchestratorTicks, orchestratorWatches, projects, removedProjects,
  sessionEvents, sessions, settings,
} from "../db/schema.ts";
import type { Item, Watch } from "../lib/orchestrator/types.ts";
import { createPgOrchestratorStore } from "../orchestrator/pg-store.ts";
import { createPgProjectsBackend } from "../projects/pg-store.ts";
import { loadServerKey } from "../settings/crypto.ts";
import { createPgSettingsStore } from "../settings/pg-settings-store.ts";
import {
  type LegacyOrchestrator, type LegacyProjects, type LegacySessions, type LegacySettings,
  legacyDataFiles, readLegacyOrchestrator, readLegacyProjects, readLegacySessions, readLegacySettings,
} from "./readers.ts";

/** The `settings` row that records a finished import. */
export const IMPORT_MARKER_KEY = "legacy_import";

/** Rows per multi-row insert: 4 parameters per event row stays far under Postgres's 65535. */
const EVENT_BATCH = 1000;

export type ImportCounts = {
  projects: number;
  removedProjects: number;
  sessions: number;
  events: number;
  /** Settings sections (gitActions, orchestrator, scripts) applied. */
  settings: number;
  apiKeys: number;
  messages: number;
  items: number;
  watches: number;
  ticks: number;
  snapshot: number;
  memory: number;
};

export type ImportMarker = { importedAt: number; home: string; counts: ImportCounts };

export type ImportResult =
  | { status: "skipped"; reason: "already-imported"; marker: ImportMarker; warnings: string[] }
  | { status: "skipped"; reason: "nothing-to-import"; warnings: string[] }
  | {
    status: "imported" | "dry-run";
    counts: ImportCounts;
    warnings: string[];
    /** Where the summary was written (absent on a dry run). */
    markerFile?: string;
    /** Where settings.json went (absent when there was none or it was unreadable, on a dry run, or when the rename failed; see warnings). */
    settingsBackup?: string;
  };

export type ImportLog = { info(message: string): void; warn(message: string): void };

export type ImportOptions = {
  /** The legacy Portal home (`PORTAL_HOME` or `~/.portal`); its `server.key` seals the API keys. */
  home: string;
  db: Db;
  log?: ImportLog;
  /** Read and count everything, write nothing (no rows, no files, no rename, not even a server key). */
  dryRun?: boolean;
  /** Import even though the marker row says it was done. */
  force?: boolean;
  /** For tests: the clock used for `importedAt` and the file names. */
  now?: () => number;
};

const silent: ImportLog = { info() {}, warn() {} };

const emptyCounts = (): ImportCounts => ({
  projects: 0, removedProjects: 0, sessions: 0, events: 0, settings: 0, apiKeys: 0,
  messages: 0, items: 0, watches: 0, ticks: 0, snapshot: 0, memory: 0,
});

/** The marker row, or null when no import has finished. */
export async function readImportMarker(db: Db): Promise<ImportMarker | null> {
  const [row] = await db.select({ body: settings.body }).from(settings).where(eq(settings.key, IMPORT_MARKER_KEY));
  return row ? (row.body as unknown as ImportMarker) : null;
}

/** Whether any legacy file that carries data exists in `home`. */
export async function hasLegacyData(home: string): Promise<boolean> {
  const found = await Promise.all(legacyDataFiles(home).map((file) => stat(file).then((info) => info.isFile(), () => false)));
  return found.some(Boolean);
}

/** True when neither sessions nor projects hold a row: a database nobody has used yet. */
export async function databaseIsEmpty(db: Db): Promise<boolean> {
  const [[s], [p]] = await Promise.all([
    db.select({ n: count() }).from(sessions),
    db.select({ n: count() }).from(projects),
  ]);
  return (s?.n ?? 0) === 0 && (p?.n ?? 0) === 0;
}

/** One line for logs and the CLI. */
export function describeCounts(counts: ImportCounts): string {
  return [
    `${counts.projects} projects (${counts.removedProjects} removed)`,
    `${counts.sessions} sessions (${counts.events} events)`,
    `${counts.settings} settings sections (${counts.apiKeys} API keys)`,
    `${counts.messages} messages, ${counts.items} items, ${counts.watches} watches, ${counts.ticks} ticks`,
    `snapshot ${counts.snapshot ? "yes" : "no"}, memory ${counts.memory ? "yes" : "no"}`,
  ].join("; ");
}

/** `rows` in slices of `size`, for multi-row inserts that must stay under the parameter limit. */
function chunks<T>(rows: T[], size = EVENT_BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** A file-name-safe timestamp, shared by the marker file and the settings backup of one run. */
const stamp = (at: number) => new Date(at).toISOString().replace(/[:.]/g, "-");

type Legacy = {
  projects: LegacyProjects | null;
  sessions: LegacySessions | null;
  settings: LegacySettings | null;
  orchestrator: LegacyOrchestrator | null;
};

export async function importLegacyHome({ home, db, log = silent, dryRun = false, force = false, now = Date.now }: ImportOptions): Promise<ImportResult> {
  home = path.resolve(home);
  if (!force) {
    const marker = await readImportMarkerIfMigrated(db);
    if (marker) return { status: "skipped", reason: "already-imported", marker, warnings: [] };
  }
  const legacy: Legacy = {
    projects: await readLegacyProjects(home),
    sessions: await readLegacySessions(home),
    settings: await readLegacySettings(home),
    orchestrator: await readLegacyOrchestrator(home),
  };
  // Reading a session log appends to the sessions warnings, so collect them only once everything has been read.
  const warnings = () => [legacy.projects, legacy.sessions, legacy.settings, legacy.orchestrator].flatMap((domain) => domain?.warnings ?? []);
  if (!legacy.projects && !legacy.sessions && !legacy.settings && !legacy.orchestrator) {
    return { status: "skipped", reason: "nothing-to-import", warnings: warnings() };
  }
  if (dryRun) {
    const counts = await countLegacy(legacy);
    return { status: "dry-run", counts, warnings: warnings() };
  }

  const importedAt = now();
  const counts = await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    // Two servers booting against one database must not both import.
    await t.execute(sql`select pg_advisory_xact_lock(hashtext('portal.legacy_import'))`);
    if (!force && (await readImportMarker(t))) return null;
    const counts = emptyCounts();
    if (legacy.projects) await writeProjects(t, legacy.projects, counts);
    if (legacy.sessions) await writeSessions(t, legacy.sessions, counts);
    if (legacy.orchestrator) await writeOrchestrator(t, legacy.orchestrator, counts);
    if (legacy.settings && legacy.settings.sections > 0) {
      const store = createPgSettingsStore({ db: t, key: () => loadServerKey(home), warn: (message) => log.warn(message) });
      await store.patch(legacy.settings.patch);
      counts.settings = legacy.settings.sections;
      counts.apiKeys = legacy.settings.apiKeys;
    }
    const marker: ImportMarker = { importedAt, home, counts };
    const body = marker as unknown as Record<string, unknown>;
    await t.insert(settings).values({ key: IMPORT_MARKER_KEY, body, updatedAt: importedAt })
      .onConflictDoUpdate({ target: settings.key, set: { body, updatedAt: importedAt } });
    return counts;
  });
  if (!counts) {
    // Another process finished the import while this one waited for the lock.
    const marker = await readImportMarker(db);
    if (marker) return { status: "skipped", reason: "already-imported", marker, warnings: [] };
    throw new Error("The legacy import was skipped by another process that did not record it.");
  }
  const notes = warnings();

  // The database is committed; the file steps below only tidy up, so their failures are warnings.
  let settingsBackup: string | undefined;
  if (legacy.settings?.parsed) {
    const target = `${legacy.settings.file}.imported-${stamp(importedAt)}`;
    try {
      await rename(legacy.settings.file, target);
      await chmod(target, 0o600);
      settingsBackup = target;
    } catch (err) {
      notes.push(`Could not move ${legacy.settings.file} aside (${(err as Error).message}); it still holds API keys in plain text, so delete it by hand.`);
    }
  }
  const markerFile = path.join(home, `IMPORTED-${stamp(importedAt)}.json`);
  const summary = { importedAt, home, counts, ...(settingsBackup ? { settingsBackup } : {}), warnings: notes };
  try {
    await writeFile(markerFile, JSON.stringify(summary, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  } catch (err) {
    notes.push(`Could not write ${markerFile}: ${(err as Error).message}`);
  }
  for (const warning of notes) log.warn(`Legacy import: ${warning}`);
  return { status: "imported", counts, warnings: notes, markerFile, ...(settingsBackup ? { settingsBackup } : {}) };
}

/** The marker, or null also when the tables do not exist yet (a dry run against an unmigrated database). */
async function readImportMarkerIfMigrated(db: Db): Promise<ImportMarker | null> {
  try {
    return await readImportMarker(db);
  } catch (err) {
    const code = (e: unknown) => (e as { code?: unknown } | null)?.code;
    if (code(err) === "42P01" || code((err as { cause?: unknown }).cause) === "42P01") return null;
    throw err;
  }
}

/** What an import would write into an empty database. */
async function countLegacy(legacy: Legacy): Promise<ImportCounts> {
  const counts = emptyCounts();
  if (legacy.projects) {
    counts.projects = legacy.projects.projects.length;
    counts.removedProjects = legacy.projects.removed.length;
  }
  if (legacy.sessions) {
    counts.sessions = legacy.sessions.sessions.length;
    for (const record of legacy.sessions.sessions) {
      for await (const batch of legacy.sessions.events(record.id, EVENT_BATCH)) counts.events += batch.length;
    }
  }
  if (legacy.settings) {
    counts.settings = legacy.settings.sections;
    counts.apiKeys = legacy.settings.apiKeys;
  }
  if (legacy.orchestrator) {
    const o = legacy.orchestrator;
    Object.assign(counts, { messages: o.messages.length, items: o.items.length, watches: o.watches.length, ticks: o.ticks.length });
    counts.snapshot = o.snapshot ? 1 : 0;
    counts.memory = o.memory !== null ? 1 : 0;
  }
  return counts;
}

async function writeProjects(db: Db, legacy: LegacyProjects, counts: ImportCounts) {
  const ids = [...legacy.projects, ...legacy.removed].map((p) => p.id);
  const taken = new Set<string>();
  if (ids.length > 0) {
    for (const row of await db.select({ id: projects.id }).from(projects).where(inArray(projects.id, ids))) taken.add(row.id);
    for (const row of await db.select({ id: removedProjects.id }).from(removedProjects).where(inArray(removedProjects.id, ids))) taken.add(row.id);
  }
  // Through the projects backend, one row at a time in file order: `ordinal` then breaks createdAt ties as the file did.
  const backend = createPgProjectsBackend(db);
  for (const project of legacy.projects) {
    if (taken.has(project.id)) continue;
    await backend.insert(project);
    counts.projects++;
  }
  for (const record of legacy.removed) {
    if (taken.has(record.id)) continue;
    await backend.remove(record.id, record);
    counts.removedProjects++;
  }
}

async function writeSessions(db: Db, legacy: LegacySessions, counts: ImportCounts) {
  if (legacy.sessions.length === 0) return;
  // One insert in index order, so `ordinal` (the listing order) follows the old index.
  const inserted = new Set<string>();
  for (const slice of chunks(legacy.sessions)) {
    for (const row of await db.insert(sessions).values(slice).onConflictDoNothing().returning({ id: sessions.id })) inserted.add(row.id);
  }
  for (const record of legacy.sessions) {
    // A session that already existed (a forced re-run) keeps its own log.
    if (!inserted.has(record.id)) continue;
    counts.sessions++;
    for await (const batch of legacy.events(record.id, EVENT_BATCH)) {
      await db.insert(sessionEvents).values(batch.map((event: StoredEvent) => ({ sessionId: record.id, seq: event.seq, ts: Math.round(event.ts), body: event })));
      counts.events += batch.length;
    }
  }
}

type Body = Record<string, unknown>;

async function writeOrchestrator(db: Db, legacy: LegacyOrchestrator, counts: ImportCounts) {
  const store = createPgOrchestratorStore({ db });
  const isEmpty = async (table: typeof orchestratorMessages | typeof orchestratorTicks) => ((await db.select({ n: count() }).from(table))[0]?.n ?? 0) === 0;
  if (legacy.messages.length > 0 && (await isEmpty(orchestratorMessages))) {
    await store.writeMessages(legacy.messages);
    counts.messages = legacy.messages.length;
  }
  // Items and watches keep their ids (the model and the UI address them by id), so they are inserted
  // as rows with the store's columns rather than created anew. Oldest first, so ordinals rise with createdAt.
  for (const slice of chunks(legacy.items)) {
    const rows = await db.insert(orchestratorItems).values(slice.map((item: Item) => ({
      id: item.id, list: item.list, status: item.status, fingerprint: item.fingerprint,
      createdAt: item.createdAt, updatedAt: item.updatedAt, snoozedUntil: item.snoozedUntil, body: item as unknown as Body,
    }))).onConflictDoNothing().returning({ id: orchestratorItems.id });
    counts.items += rows.length;
  }
  for (const slice of chunks(legacy.watches)) {
    const rows = await db.insert(orchestratorWatches).values(slice.map((watch: Watch) => ({
      id: watch.id, status: watch.status, createdAt: watch.createdAt, updatedAt: watch.updatedAt,
      lastCheckedAt: watch.lastCheckedAt, body: watch as unknown as Body,
    }))).onConflictDoNothing().returning({ id: orchestratorWatches.id });
    counts.watches += rows.length;
  }
  if (legacy.ticks.length > 0 && (await isEmpty(orchestratorTicks))) {
    for (const tick of legacy.ticks) await store.appendTick(tick);
    counts.ticks = legacy.ticks.length;
  }
  const hasDocument = async (key: string) => (await db.select({ key: orchestratorDocuments.key }).from(orchestratorDocuments).where(eq(orchestratorDocuments.key, key))).length > 0;
  if (legacy.snapshot && !(await hasDocument("snapshot"))) {
    await store.writeSnapshot(legacy.snapshot);
    counts.snapshot = 1;
  }
  if (legacy.memory !== null && !(await hasDocument("memory"))) {
    await store.writeMemory(legacy.memory);
    counts.memory = 1;
  }
}
