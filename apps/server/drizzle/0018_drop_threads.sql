DROP TABLE "threads" CASCADE;--> statement-breakpoint
DROP INDEX "activity_log_thread_idx";--> statement-breakpoint
DROP INDEX "orchestrator_messages_thread_idx";--> statement-breakpoint
ALTER TABLE "activity_log" DROP COLUMN "thread_id";--> statement-breakpoint
ALTER TABLE "approvals" DROP COLUMN "thread_id";--> statement-breakpoint
ALTER TABLE "intents" DROP COLUMN "thread_id";--> statement-breakpoint
ALTER TABLE "job_runs" DROP COLUMN "thread_id";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "thread_id";--> statement-breakpoint
ALTER TABLE "orchestrator_messages" DROP COLUMN "thread_id";