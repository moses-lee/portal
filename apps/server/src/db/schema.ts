/**
 * Database schema. Sessions and their append-only event logs are the first tables; every other
 * store (projects, settings, orchestrator) lands here as it moves into the server.
 */
import { bigint, bigserial, index, integer, jsonb, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
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
 * (`~/.portal/server.key`). Only the server ever decrypts them.
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

/** The one conversation thread, one row per UI message in order. */
export const orchestratorMessages = pgTable("orchestrator_messages", {
  ordinal: bigserial("ordinal", { mode: "number" }).primaryKey(),
  id: text("id").notNull(),
  body: jsonb("body").$type<Record<string, unknown>>().notNull(),
});

export const orchestratorItems = pgTable(
  "orchestrator_items",
  {
    id: text("id").primaryKey(),
    ordinal: bigserial("ordinal", { mode: "number" }).notNull(),
    list: text("list").notNull(),
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

export const orchestratorWatches = pgTable("orchestrator_watches", {
  id: text("id").primaryKey(),
  ordinal: bigserial("ordinal", { mode: "number" }).notNull(),
  status: text("status").notNull(),
  createdAt: epochMs("created_at").notNull(),
  updatedAt: epochMs("updated_at").notNull(),
  lastCheckedAt: epochMs("last_checked_at"),
  body: jsonb("body").$type<Record<string, unknown>>().notNull(),
});

/** Tick reports, newest last; the store keeps at most MAX_TICK_REPORTS. */
export const orchestratorTicks = pgTable("orchestrator_ticks", {
  ordinal: bigserial("ordinal", { mode: "number" }).primaryKey(),
  id: text("id").notNull(),
  startedAt: epochMs("started_at").notNull(),
  finishedAt: epochMs("finished_at").notNull(),
  body: jsonb("body").$type<Record<string, unknown>>().notNull(),
});

/** Single-value documents: `snapshot` (the last tick's pre-scan) and `memory` (the Markdown notes, as `{ text }`). */
export const orchestratorDocuments = pgTable("orchestrator_documents", {
  key: text("key").primaryKey(),
  body: jsonb("body").$type<Record<string, unknown>>().notNull(),
  updatedAt: epochMs("updated_at").notNull(),
});
