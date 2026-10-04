ALTER TABLE "projects" ADD COLUMN "pinned_at" bigint;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "kept_reason" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "revived_at" bigint;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "idle_since" bigint;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "turn_ended_at" bigint;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "title_source" text DEFAULT 'prompt' NOT NULL;--> statement-breakpoint
-- Give every existing session clocks to read: idle since, and its last turn ended at, its last activity.
-- A turn still open was cut off by this restart; the next start dates both from its last event.
UPDATE "sessions" SET "idle_since" = "last_active_at", "turn_ended_at" = "last_active_at" WHERE "turn_open" IS NOT TRUE;
