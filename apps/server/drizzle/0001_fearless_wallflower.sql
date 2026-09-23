CREATE TABLE "credentials" (
	"name" text PRIMARY KEY NOT NULL,
	"ciphertext" text NOT NULL,
	"key_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orchestrator_documents" (
	"key" text PRIMARY KEY NOT NULL,
	"body" jsonb NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orchestrator_items" (
	"id" text PRIMARY KEY NOT NULL,
	"ordinal" bigserial NOT NULL,
	"list" text NOT NULL,
	"status" text NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"snoozed_until" bigint,
	"body" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orchestrator_messages" (
	"ordinal" bigserial PRIMARY KEY NOT NULL,
	"id" text NOT NULL,
	"body" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orchestrator_ticks" (
	"ordinal" bigserial PRIMARY KEY NOT NULL,
	"id" text NOT NULL,
	"started_at" bigint NOT NULL,
	"finished_at" bigint NOT NULL,
	"body" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orchestrator_watches" (
	"id" text PRIMARY KEY NOT NULL,
	"ordinal" bigserial NOT NULL,
	"status" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"last_checked_at" bigint,
	"body" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"ordinal" bigserial NOT NULL,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"created_at" bigint NOT NULL,
	"worktree" jsonb
);
--> statement-breakpoint
CREATE TABLE "removed_projects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"created_at" bigint NOT NULL,
	"worktree" jsonb,
	"removed_at" bigint NOT NULL,
	"parent_path" text
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"body" jsonb NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "orchestrator_items_fingerprint_idx" ON "orchestrator_items" USING btree ("fingerprint");