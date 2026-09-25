/**
 * Database schema for every domain: sessions and their append-only event logs, projects (and the
 * removed ones), settings and sealed credentials, and the orchestrator's records. The migrations in
 * `drizzle/` are generated from this file (`pnpm --filter @portal/server db:generate`).
 */
import { sql } from "drizzle-orm";
import { bigint, bigserial, boolean, customType, index, integer, jsonb, pgTable, primaryKey, real, text, uniqueIndex } from "drizzle-orm/pg-core";
import type { SessionState, StoredEvent, WorktreeMeta } from "@portal/contracts/types";

/** Milliseconds since the epoch, as JavaScript numbers. */
const epochMs = (name: string) => bigint(name, { mode: "number" });

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  /** Insertion order, so listings are stable without relying on timestamps that may tie. */
  ordinal: bigserial("ordinal", { mode: "number" }).notNull(),
  agentId: text("agent_id").notNull(),
  agentName: text("agent_name").notNull(),
  cwd: text("cwd").notNull(),
  projectId: text("project_id").notNull(),
  createdAt: epochMs("created_at").notNull(),
  lastActiveAt: epochMs("last_active_at").notNull(),
  title: text("title"),
  upstreamId: text("upstream_id").notNull(),
  state: jsonb("state").$type<SessionState>().notNull(),
});

export const sessionEvents = pgTable(
  "session_events",
  {
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    /** Dense from 0 per session; the runtime is the only writer. */
    seq: integer("seq").notNull(),
    ts: epochMs("ts").notNull(),
    /** The whole event, including `seq` and `ts`, so reads round-trip exactly what was appended. */
    body: jsonb("body").$type<StoredEvent>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.seq] })],
);

// ---------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  /** Insertion order, which is the order the sidebar lists projects in. */
  ordinal: bigserial("ordinal", { mode: "number" }).notNull(),
  name: text("name").notNull(),
  /** Absolute, realpath'd directory. */
  path: text("path").notNull(),
  createdAt: epochMs("created_at").notNull(),
  /** Present when this project is a worktree of another project. */
  worktree: jsonb("worktree").$type<WorktreeMeta>(),
});

/** Projects taken out of the list while sessions still referenced them; restoring relinks by id. */
export const removedProjects = pgTable("removed_projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  path: text("path").notNull(),
  createdAt: epochMs("created_at").notNull(),
  worktree: jsonb("worktree").$type<WorktreeMeta>(),
  removedAt: epochMs("removed_at").notNull(),
  /** For a worktree: the parent project's folder at removal time. */
  parentPath: text("parent_path"),
});

// ---------------------------------------------------------------------------------------------
// Settings and credentials
// ---------------------------------------------------------------------------------------------

/** One row per settings document; `overrides` holds the values that differ from the defaults, never secrets. */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  body: jsonb("body").$type<Record<string, unknown>>().notNull(),
  updatedAt: epochMs("updated_at").notNull(),
});

/**
 * Provider API keys and other secrets, encrypted at rest with the server key
 * (`<PORTAL_HOME>/server.key`). Only the server ever decrypts them.
 */
export const credentials = pgTable("credentials", {
  /** e.g. "openai", "anthropic", "github". */
  name: text("name").primaryKey(),
  /** Base64 of nonce || ciphertext || tag (AES-256-GCM). */
  ciphertext: text("ciphertext").notNull(),
  /** Identifies the server key that encrypted this row, so a rotated key can be detected. */
  keyId: text("key_id").notNull(),
  createdAt: epochMs("created_at").notNull(),
  updatedAt: epochMs("updated_at").notNull(),
});

// ---------------------------------------------------------------------------------------------
// Orchestrator (Talk to Portal), phase 1: the existing documents as rows
// ---------------------------------------------------------------------------------------------

/** Every thread's messages, one row per UI message; a thread reads its rows in `ordinal` order. */
export const orchestratorMessages = pgTable(
  "orchestrator_messages",
  {
    ordinal: bigserial("ordinal", { mode: "number" }).primaryKey(),
    id: text("id").notNull(),
    /** The main thread is "main"; rows from before threads existed belong to it. */
    threadId: text("thread_id").notNull().default("main"),
    body: jsonb("body").$type<Record<string, unknown>>().notNull(),
  },
  (table) => [index("orchestrator_messages_thread_idx").on(table.threadId, table.ordinal)],
);

export const orchestratorItems = pgTable(
  "orchestrator_items",
  {
    id: text("id").primaryKey(),
    ordinal: bigserial("ordinal", { mode: "number" }).notNull(),
    status: text("status").notNull(),
    fingerprint: text("fingerprint").notNull(),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at").notNull(),
    snoozedUntil: epochMs("snoozed_until"),
    /** The whole item, so reads round-trip exactly what was written. */
    body: jsonb("body").$type<Record<string, unknown>>().notNull(),
  },
  (table) => [index("orchestrator_items_fingerprint_idx").on(table.fingerprint)],
);

/** Single-value documents: `snapshot` (the last tick's pre-scan) and `memory` (the Markdown notes, as `{ text }`). */
export const orchestratorDocuments = pgTable("orchestrator_documents", {
  key: text("key").primaryKey(),
  body: jsonb("body").$type<Record<string, unknown>>().notNull(),
  updatedAt: epochMs("updated_at").notNull(),
});

// ---------------------------------------------------------------------------------------------
// Orchestrator v2 (phase 2): threads, activity, jobs and runs, intents, world, memory, approvals.
// Real columns rather than one `body`: these tables are queried by status, time, and owner.
// Wire shapes are in @portal/contracts (orchestrator, activity, jobs, world, memory, approvals).
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

/** Postgres `tsvector`, for the generated full-text column of memory records. */
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

export const threads = pgTable("threads", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull(),
  scope: jsonb("scope").$type<Json>().notNull(),
  intentId: text("intent_id"),
  createdAt: epochMs("created_at").notNull(),
  updatedAt: epochMs("updated_at").notNull(),
  lastMessageAt: epochMs("last_message_at"),
});

/** Append-only; nothing updates or deletes a row. */
export const activityLog = pgTable(
  "activity_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: epochMs("at").notNull(),
    actor: text("actor").notNull(),
    kind: text("kind").notNull(),
    summary: text("summary").notNull(),
    refs: jsonb("refs").$type<Json>().notNull(),
    detail: jsonb("detail").$type<Json>(),
    /** Copied out of `refs` for the filters the views use. */
    threadId: text("thread_id"),
    runId: text("run_id"),
  },
  (table) => [
    index("activity_log_at_idx").on(table.at),
    index("activity_log_kind_idx").on(table.kind, table.id),
    index("activity_log_thread_idx").on(table.threadId, table.id),
    index("activity_log_run_idx").on(table.runId, table.id),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    schedule: jsonb("schedule").$type<Json>().notNull(),
    payload: jsonb("payload").$type<Json>().notNull(),
    status: text("status").notNull(),
    nextRunAt: epochMs("next_run_at"),
    lastRunAt: epochMs("last_run_at"),
    lastRunId: text("last_run_id"),
    intentId: text("intent_id"),
    threadId: text("thread_id"),
    createdBy: text("created_by").notNull(),
    failures: integer("failures").notNull().default(0),
    /** A claimed job is leased until this time; a worker that died loses the lease. */
    lockedUntil: epochMs("locked_until"),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at").notNull(),
  },
  (table) => [index("jobs_due_idx").on(table.status, table.nextRunAt)],
);

export const jobRuns = pgTable(
  "job_runs",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id"),
    kind: text("kind").notNull(),
    threadId: text("thread_id"),
    parentRunId: text("parent_run_id"),
    status: text("status").notNull(),
    trigger: text("trigger").notNull(),
    startedAt: epochMs("started_at").notNull(),
    finishedAt: epochMs("finished_at"),
    model: jsonb("model").$type<Json>(),
    usage: jsonb("usage").$type<Json>(),
    log: jsonb("log").$type<string[]>().notNull(),
    result: jsonb("result").$type<Json>(),
    summary: text("summary"),
    error: text("error"),
  },
  (table) => [
    index("job_runs_started_idx").on(table.startedAt),
    index("job_runs_job_idx").on(table.jobId, table.startedAt),
    index("job_runs_status_idx").on(table.status),
  ],
);

export const intents = pgTable(
  "intents",
  {
    id: text("id").primaryKey(),
    text: text("text").notNull(),
    trigger: text("trigger").notNull(),
    action: text("action").notNull(),
    notes: text("notes").notNull(),
    scope: jsonb("scope").$type<Json>().notNull(),
    status: text("status").notNull(),
    expiresAt: epochMs("expires_at"),
    fireBudget: integer("fire_budget"),
    fires: integer("fires").notNull().default(0),
    cooldownMs: epochMs("cooldown_ms").notNull(),
    lastFiredAt: epochMs("last_fired_at"),
    lastFiredTitle: text("last_fired_title"),
    lastCheckedAt: epochMs("last_checked_at"),
    threadId: text("thread_id"),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at").notNull(),
  },
  (table) => [index("intents_status_idx").on(table.status)],
);

/** The world as each build saw it; the newest is the current world, older ones are for audits. */
export const worldSnapshots = pgTable(
  "world_snapshots",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: epochMs("at").notNull(),
    body: jsonb("body").$type<Json>().notNull(),
  },
  (table) => [index("world_snapshots_at_idx").on(table.at)],
);

/**
 * The change log: what each full world refresh found changed since the one before, one row per
 * subject holding its latest state (see `orchestrator/world/changes.ts`). Chat turns read it.
 */
export const worldChanges = pgTable(
  "world_changes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** What the change is about ("pr:owner/name#7", "review:owner/name#7", "session:<id>", "worktree:<id>", "folder:<id>"). */
    subject: text("subject").notNull(),
    /** When the refresh detected the latest state. */
    at: epochMs("at").notNull(),
    kind: text("kind").notNull(),
    fingerprint: text("fingerprint").notNull(),
    summary: text("summary").notNull(),
    detail: text("detail"),
    refs: jsonb("refs").$type<Json>().notNull(),
    /** The user's own subject: a PR they authored, a session. */
    mine: boolean("mine").notNull().default(false),
    /** When the user last acted on the subject (opened or pushed the PR, started or prompted the session). */
    activeAt: epochMs("active_at"),
  },
  (table) => [uniqueIndex("world_changes_subject_idx").on(table.subject), index("world_changes_at_idx").on(table.at)],
);

export const memoryEntities = pgTable(
  "memory_entities",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    summary: text("summary").notNull(),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at").notNull(),
  },
  (table) => [uniqueIndex("memory_entities_type_key_idx").on(table.type, table.key)],
);

export const memoryRecords = pgTable(
  "memory_records",
  {
    id: text("id").primaryKey(),
    entityId: text("entity_id").notNull().references(() => memoryEntities.id),
    type: text("type").notNull(),
    key: text("key").notNull(),
    body: text("body").notNull(),
    status: text("status").notNull(),
    scope: jsonb("scope").$type<Json>().notNull(),
    authority: text("authority").notNull(),
    source: jsonb("source").$type<Json>().notNull(),
    /** Further sources of the same claim while it was proposed (see MemoryRecord.sightings). */
    sightings: jsonb("sightings").$type<Json[]>().notNull().default([]),
    trust: real("trust").notNull(),
    pinned: boolean("pinned").notNull().default(false),
    reviewBy: epochMs("review_by"),
    supersedes: text("supersedes"),
    supersededBy: text("superseded_by"),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at").notNull(),
    /** Full-text search over the key and the claim; Postgres keeps it current. */
    search: tsvector("search").generatedAlwaysAs(sql`to_tsvector('english', replace(key, '-', ' ') || ' ' || body)`),
  },
  (table) => [
    /** One active claim per key and entity, so a contradiction is a conflict rather than a silent second answer. */
    uniqueIndex("memory_records_active_key_idx").on(table.entityId, table.key).where(sql`status = 'active'`),
    index("memory_records_status_idx").on(table.status),
    index("memory_records_search_idx").using("gin", table.search),
  ],
);

/** Every change to memory, with the record before and after. Append-only. */
export const memoryRevisions = pgTable(
  "memory_revisions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    recordId: text("record_id"),
    entityId: text("entity_id"),
    at: epochMs("at").notNull(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    before: jsonb("before").$type<Json>(),
    after: jsonb("after").$type<Json>(),
    reason: text("reason"),
    runId: text("run_id"),
  },
  (table) => [index("memory_revisions_record_idx").on(table.recordId, table.id), index("memory_revisions_at_idx").on(table.at)],
);

export const approvals = pgTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    status: text("status").notNull(),
    tool: text("tool").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    input: jsonb("input").$type<Json>().notNull(),
    risk: text("risk").notNull(),
    origin: text("origin").notNull(),
    repo: text("repo"),
    threadId: text("thread_id"),
    runId: text("run_id"),
    jobId: text("job_id"),
    intentId: text("intent_id"),
    itemId: text("item_id"),
    requestedAt: epochMs("requested_at").notNull(),
    expiresAt: epochMs("expires_at").notNull(),
    decidedAt: epochMs("decided_at"),
    decision: jsonb("decision").$type<Json>(),
    result: jsonb("result").$type<unknown>(),
    error: text("error"),
  },
  (table) => [index("approvals_status_idx").on(table.status, table.requestedAt)],
);

export const approvalGrants = pgTable("approval_grants", {
  id: text("id").primaryKey(),
  tool: text("tool").notNull(),
  scope: text("scope").notNull(),
  jobId: text("job_id"),
  intentId: text("intent_id"),
  repo: text("repo"),
  approvalId: text("approval_id").notNull(),
  createdAt: epochMs("created_at").notNull(),
  revokedAt: epochMs("revoked_at"),
});
