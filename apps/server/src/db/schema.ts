/**
 * Database schema. Sessions and their append-only event logs are the first tables; every other
 * store (projects, settings, orchestrator) lands here as it moves into the server.
 */
import { bigint, bigserial, integer, jsonb, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import type { SessionState, StoredEvent } from "@portal/contracts/types";

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
