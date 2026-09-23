CREATE TABLE "activity_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" bigint NOT NULL,
	"actor" text NOT NULL,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"refs" jsonb NOT NULL,
	"detail" jsonb,
	"thread_id" text,
	"run_id" text
);
--> statement-breakpoint
CREATE TABLE "approval_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"tool" text NOT NULL,
	"scope" text NOT NULL,
	"job_id" text,
	"intent_id" text,
	"repo" text,
	"approval_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	"revoked_at" bigint
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"tool" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"input" jsonb NOT NULL,
	"risk" text NOT NULL,
	"origin" text NOT NULL,
	"repo" text,
	"thread_id" text,
	"run_id" text,
	"job_id" text,
	"intent_id" text,
	"item_id" text,
	"requested_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"decided_at" bigint,
	"decision" jsonb,
	"result" jsonb,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "intents" (
	"id" text PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"trigger" text NOT NULL,
	"action" text NOT NULL,
	"notes" text NOT NULL,
	"scope" jsonb NOT NULL,
	"status" text NOT NULL,
	"expires_at" bigint,
	"fire_budget" integer,
	"fires" integer DEFAULT 0 NOT NULL,
	"cooldown_ms" bigint NOT NULL,
	"last_fired_at" bigint,
	"last_checked_at" bigint,
	"thread_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text,
	"kind" text NOT NULL,
	"thread_id" text,
	"parent_run_id" text,
	"status" text NOT NULL,
	"trigger" text NOT NULL,
	"started_at" bigint NOT NULL,
	"finished_at" bigint,
	"model" jsonb,
	"usage" jsonb,
	"log" jsonb NOT NULL,
	"result" jsonb,
	"summary" text,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"schedule" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text NOT NULL,
	"next_run_at" bigint,
	"last_run_at" bigint,
	"last_run_id" text,
	"intent_id" text,
	"thread_id" text,
	"created_by" text NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"locked_until" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_entities" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"summary" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_records" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_id" text NOT NULL,
	"type" text NOT NULL,
	"key" text NOT NULL,
	"body" text NOT NULL,
	"status" text NOT NULL,
	"scope" jsonb NOT NULL,
	"authority" text NOT NULL,
	"source" jsonb NOT NULL,
	"trust" real NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"review_by" bigint,
	"supersedes" text,
	"superseded_by" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', replace(key, '-', ' ') || ' ' || body)) STORED
);
--> statement-breakpoint
CREATE TABLE "memory_revisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"record_id" text,
	"entity_id" text,
	"at" bigint NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"run_id" text
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"scope" jsonb NOT NULL,
	"intent_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"last_message_at" bigint
);
--> statement-breakpoint
CREATE TABLE "world_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" bigint NOT NULL,
	"body" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orchestrator_messages" ADD COLUMN "thread_id" text DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_entity_id_memory_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."memory_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_log_at_idx" ON "activity_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "activity_log_kind_idx" ON "activity_log" USING btree ("kind","id");--> statement-breakpoint
CREATE INDEX "activity_log_thread_idx" ON "activity_log" USING btree ("thread_id","id");--> statement-breakpoint
CREATE INDEX "activity_log_run_idx" ON "activity_log" USING btree ("run_id","id");--> statement-breakpoint
CREATE INDEX "approvals_status_idx" ON "approvals" USING btree ("status","requested_at");--> statement-breakpoint
CREATE INDEX "intents_status_idx" ON "intents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "job_runs_started_idx" ON "job_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "job_runs_job_idx" ON "job_runs" USING btree ("job_id","started_at");--> statement-breakpoint
CREATE INDEX "job_runs_status_idx" ON "job_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "jobs_due_idx" ON "jobs" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_entities_type_key_idx" ON "memory_entities" USING btree ("type","key");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_records_active_key_idx" ON "memory_records" USING btree ("entity_id","key") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "memory_records_status_idx" ON "memory_records" USING btree ("status");--> statement-breakpoint
CREATE INDEX "memory_records_search_idx" ON "memory_records" USING gin ("search");--> statement-breakpoint
CREATE INDEX "memory_revisions_record_idx" ON "memory_revisions" USING btree ("record_id","id");--> statement-breakpoint
CREATE INDEX "memory_revisions_at_idx" ON "memory_revisions" USING btree ("at");--> statement-breakpoint
CREATE INDEX "world_snapshots_at_idx" ON "world_snapshots" USING btree ("at");--> statement-breakpoint
CREATE INDEX "orchestrator_messages_thread_idx" ON "orchestrator_messages" USING btree ("thread_id","ordinal");--> statement-breakpoint
INSERT INTO "threads" ("id", "kind", "title", "status", "scope", "intent_id", "created_at", "updated_at", "last_message_at")
VALUES ('main', 'main', 'Portal', 'active', '{"projectIds":[],"sessionIds":[],"pulls":[],"repos":[],"people":[],"taskTypes":[]}'::jsonb, NULL,
  (extract(epoch from now()) * 1000)::bigint, (extract(epoch from now()) * 1000)::bigint, NULL)
ON CONFLICT ("id") DO NOTHING;
